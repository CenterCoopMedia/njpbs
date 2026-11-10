"""The broker parent must receive JSON values without importing model libraries."""
import builtins
import importlib.util
import json
import pickle
import sys
import unittest
from unittest.mock import Mock, patch

import worker
from test_worker import RealChildContext, fixture


def numpy_result_child(connection, *_):
    # NumPy stays in the inference child, as it does during model inference.
    import numpy as np
    words = [{'start': np.float64(index / 4), 'end': np.float64(index / 4 + .125),
              'text': np.str_('synthetic word ' + str(index) + ' x' * 60),
              'confidence': np.float32(.875)} for index in range(18000)]
    turns = [(np.float64(0), np.float64(4500), 'A')]
    regular = turns + [(np.float64(.0625), np.float64(.1875), 'B')]
    try:
        connection.send(('stage', 'finalizing'))
        result = worker.assign_speakers(words, turns, 2, regular)
        connection.send(('result', result))
    finally:
        connection.close()


def assert_primitives(test, value):
    test.assertIn(type(value), (dict, list, str, float, int, bool, type(None)))
    if type(value) is dict:
        for key, item in value.items():
            test.assertIs(type(key), str)
            assert_primitives(test, item)
    elif type(value) is list:
        for item in value:
            assert_primitives(test, item)


class ResultPrimitiveTest(unittest.TestCase):
    def test_numeric_subclasses_become_builtin_values(self):
        class ModelFloat(float):
            pass
        words = [{'start': ModelFloat(.25), 'end': ModelFloat(.5),
                  'confidence': ModelFloat(.875), 'text': 'word'}]
        result = worker.assign_speakers(words, [(0, 1, 'A')], 2)
        assert_primitives(self, result)
        self.assertEqual(result[0]['words'][0],
                         {'startSeconds': .25, 'endSeconds': .5, 'confidence': .875, 'text': 'word'})
        self.assertEqual(json.loads(json.dumps(result, allow_nan=False)), result)

    @unittest.skipUnless(importlib.util.find_spec('numpy'), 'NumPy scalar integration requires NumPy')
    def test_numpy_child_result_does_not_import_numpy_into_parent(self):
        self.assertNotIn('numpy', sys.modules)
        original_import = builtins.__import__

        def guarded_import(name, *args, **kwargs):
            if name == 'numpy' or name.startswith('numpy.'):
                raise AssertionError('Result decoding imported NumPy into the broker parent')
            return original_import(name, *args, **kwargs)

        context = RealChildContext(numpy_result_child)
        with patch.object(worker.multiprocessing, 'get_context', return_value=context), \
             patch('builtins.__import__', side_effect=guarded_import):
            result = worker.transcribe_in_process('unused', fixture(), Mock(), None, None)
        assert_primitives(self, result)
        words = [word for segment in result for word in segment['words']]
        self.assertEqual(len(words), 18000)
        self.assertEqual(words[0]['startSeconds'], 0)
        self.assertEqual(words[0]['endSeconds'], .125)
        self.assertEqual(words[-1]['startSeconds'], 4499.75)
        self.assertEqual(words[-1]['endSeconds'], 4499.875)
        self.assertTrue(all(word['confidence'] == .875 for word in words))
        self.assertIs(result[0]['overlappingSpeech'], True)
        self.assertIs(result[1]['overlappingSpeech'], False)
        self.assertGreater(len(pickle.dumps(result)), 2_000_000)
        self.assertEqual(json.loads(json.dumps(result, allow_nan=False)), result)
        self.assertNotIn('numpy', sys.modules)


if __name__ == '__main__':
    unittest.main()
