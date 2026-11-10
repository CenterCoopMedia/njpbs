import io
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch
import relay

TOKEN = 'a' * 48


class Pipe(io.StringIO):
    def close(self):
        self.saved = self.getvalue()
        super().close()


class Event:
    def __init__(self, stopped=False):
        self.stopped = stopped
    def is_set(self):
        return self.stopped
    def set(self):
        self.stopped = True
    def wait(self, _):
        self.stopped = True
        return True


class RelayTest(unittest.TestCase):
    def execute(self, disconnected=False):
        child = Mock()
        child.stdin = Pipe()
        child.poll.return_value = 0 if disconnected else None
        child.returncode = 0
        event = Event()
        argv = ['ssh', 'node-services', 'approved-worker-command']
        with patch.object(relay.subprocess, 'run', return_value=SimpleNamespace(stdout=TOKEN + '\n')) as retrieve, \
             patch.object(relay.subprocess, 'Popen', return_value=child) as launch, \
             patch.object(relay.threading, 'Event', return_value=event), \
             patch.object(relay.signal, 'signal'):
            result = relay.run({'argv': argv, 'credential_command': ['credential-provider']})
        return result, child, retrieve, launch, argv

    def test_credential_travels_only_in_stdin(self):
        result, child, retrieve, launch, argv = self.execute()
        self.assertEqual(result, 0)
        self.assertEqual(child.stdin.saved, '{"token": "' + TOKEN + '"}\n')
        self.assertEqual(launch.call_args.args, (argv,))
        self.assertNotIn(TOKEN, str(launch.call_args))
        self.assertNotIn(TOKEN, str(retrieve.call_args))
        self.assertEqual(launch.call_args.kwargs, {'stdin': relay.subprocess.PIPE, 'text': True})

    def test_shutdown_closes_stdin_before_waiting(self):
        child = Mock()
        child.stdin = Pipe()
        child.poll.return_value = None
        child.returncode = 0
        def wait(**_):
            self.assertTrue(child.stdin.closed)
            return 0
        child.wait.side_effect = wait
        with patch.object(relay.subprocess, 'run', return_value=SimpleNamespace(stdout=TOKEN)), \
             patch.object(relay.subprocess, 'Popen', return_value=child), \
             patch.object(relay.threading, 'Event', return_value=Event()), \
             patch.object(relay.signal, 'signal'):
            self.assertEqual(relay.run({'argv': ['ssh'], 'credential_command': ['credential-provider']}), 0)
        child.terminate.assert_not_called()

    def test_unexpected_clean_disconnect_requests_supervisor_restart(self):
        result, _, _, _, _ = self.execute(disconnected=True)
        self.assertEqual(result, 1)

    def test_broken_pipe_still_waits_for_owned_child_cleanup(self):
        child = Mock()
        child.poll.return_value = 0
        child.returncode = 0
        child.stdin.close.side_effect = BrokenPipeError()
        with patch.object(relay.subprocess, 'run', return_value=SimpleNamespace(stdout=TOKEN)), \
             patch.object(relay.subprocess, 'Popen', return_value=child), \
             patch.object(relay.signal, 'signal'):
            self.assertEqual(relay.run({'argv': ['ssh'], 'credential_command': ['credential-provider']}), 1)
        child.wait.assert_called_once_with(timeout=45)

    def test_invalid_credential_does_not_start_worker(self):
        with patch.object(relay.subprocess, 'run', return_value=SimpleNamespace(stdout='invalid')), \
             patch.object(relay.subprocess, 'Popen') as launch:
            with self.assertRaises(ValueError):
                relay.run({'argv': ['ssh'], 'credential_command': ['credential-provider']})
        launch.assert_not_called()


if __name__ == '__main__':
    unittest.main()
