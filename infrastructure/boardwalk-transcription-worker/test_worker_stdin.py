import ctypes
import multiprocessing
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
import time
import unittest
from unittest.mock import Mock, patch

import worker


def stdin_probe():
    """Exercise the relay pipe with a real child, without credentials or models."""
    assert sys.stdin.readline() == 'synthetic control line\n'
    closed = threading.Event()

    def watch():
        assert sys.stdin.read(1) == ''
        closed.set()

    threading.Thread(target=watch, daemon=True).start()
    child = multiprocessing.get_context('spawn').Process(target=time.sleep, args=(0.1,))
    worker.start_inference_process(child)
    child.join(timeout=10)
    if child.is_alive():
        child.terminate()
        child.join(timeout=5)
        raise AssertionError('Synthetic child did not exit')
    assert child.exitcode == 0
    assert not closed.wait(0.2), 'Child startup closed the relay pipe'
    print('Child exited 0; relay pipe open', flush=True)
    assert closed.wait(10), 'Real relay EOF did not stop the watcher'
    print('Real relay EOF received', flush=True)


class StdinTest(unittest.TestCase):
    def test_windows_restores_control_handle_after_start_error(self):
        kernel = Mock()
        kernel.GetStdHandle.return_value = 123
        kernel.SetStdHandle.return_value = True
        process = Mock()
        process.start.side_effect = RuntimeError('start failed')
        runtime = Mock()
        runtime.get_osfhandle.return_value = 456
        with patch.object(worker.os, 'name', 'nt'), \
             patch.object(ctypes, 'WinDLL', return_value=kernel, create=True), \
             patch.dict(sys.modules, {'msvcrt': runtime}):
            with self.assertRaisesRegex(RuntimeError, 'start failed'):
                worker.start_inference_process(process)
        self.assertEqual(kernel.SetStdHandle.call_args_list[0].args, (-10, 456))
        self.assertEqual(kernel.SetStdHandle.call_args_list[1].args, (-10, 123))

    def test_failed_windows_redirection_does_not_launch_child(self):
        kernel = Mock()
        kernel.SetStdHandle.return_value = False
        process = Mock()
        with patch.object(worker.os, 'name', 'nt'), \
             patch.object(ctypes, 'WinDLL', return_value=kernel, create=True), \
             patch.object(ctypes, 'WinError', return_value=OSError('redirect failed'), create=True), \
             patch.dict(sys.modules, {'msvcrt': Mock()}):
            with self.assertRaisesRegex(OSError, 'redirect failed'):
                worker.start_inference_process(process)
        process.start.assert_not_called()

    @unittest.skipUnless(os.name == 'nt', 'Windows standard-input inheritance')
    def test_spawn_preserves_open_pipe_until_real_relay_eof(self):
        process = subprocess.Popen(
            [sys.executable, '-c', 'from test_worker_stdin import stdin_probe; stdin_probe()'],
            cwd=Path(__file__).parent, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        )
        lines = queue.Queue()

        def collect():
            for line in process.stdout:
                lines.put(line.strip())

        reader = threading.Thread(target=collect, daemon=True)
        reader.start()
        try:
            process.stdin.write('synthetic control line\n')
            process.stdin.flush()
            self.assertEqual(lines.get(timeout=15), 'Child exited 0; relay pipe open')
            self.assertIsNone(process.poll())
            process.stdin.close()
            self.assertEqual(lines.get(timeout=15), 'Real relay EOF received')
            self.assertEqual(process.wait(timeout=15), 0)
        finally:
            if not process.stdin.closed:
                process.stdin.close()
            if process.poll() is None:
                process.kill()
            process.wait(timeout=5)
            reader.join(timeout=5)
            process.stdout.close()


if __name__ == '__main__':
    unittest.main()
