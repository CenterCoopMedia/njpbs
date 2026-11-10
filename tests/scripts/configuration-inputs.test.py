import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('configuration_inputs', ROOT / 'scripts/check-configuration-inputs.py')
contract = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(contract)


def configuration(*names):
    return {'suppliers': {'configured-process': {'supplier': 'Process environment', 'scope': 'Test process',
            'deployStep': 'Supply before startup'}},
        'inputs': [{'suppliers': ['configured-process'], 'names': sorted(names)}]}


class ConfigurationInputsContract(unittest.TestCase):
    def test_static_configuration_forms_and_comment_exclusion(self):
        files = {'scripts/runtime.mjs': '''
            // process.env.COMMENT_ONLY
            /* environment.BLOCK_COMMENT */
            const direct = process.env.DIRECT_INPUT;
            const optional = env?.OPTIONAL_INPUT;
            const bracket = environment["BRACKET_INPUT"];
            const { FIRST_INPUT, SECOND_INPUT: alias } = process.env;
            const param = defineString("FUNCTIONS_INPUT");
            const secret = defineSecret("FUNCTIONS_SECRET");
            const list = defineList("FUNCTIONS_LIST");
            const email = deploymentEmail("EMAIL_INPUT", environment);
            const configured = loadEnv(mode, root, "BUILD_INPUT").BUILD_INPUT;
            // config-input: DYNAMIC_INPUT
            const computed = env[providedKey];
        ''', 'worker.ts': 'export default { fetch(request, env) { return env.WORKER_INPUT; } }',
            'scripts/observer.py': '# os.environ["COMMENT_ONLY"]\nvalue = os.environ.get("PYTHON_INPUT")',
            'scripts/operator.sh': '# ${COMMENT_ONLY}\nreadonly FIXED=local\n: "${SHELL_INPUT:?}"\necho "${FIXED}"',
            'scripts/studio.ps1': '# $env:COMMENT_ONLY\n$value = $env:STUDIO_INPUT',
            'wordpress/adapter.php': '<?php $id = getenv("WORDPRESS_INPUT");',
            '.github/workflows/deploy.yml': 'env:\n  INPUT: ${{ vars.GITHUB_INPUT }}\n  TOKEN: ${{ secrets.GITHUB_SECRET }}',
            'wrangler.jsonc': '{"id":"${NAMESPACE_INPUT}"}',
            'tests/fixtures/example.mjs': 'process.env.FIXTURE_ONLY',
            'scripts/runtime.test.mjs': 'process.env.TEST_ONLY'}
        expected = {'DIRECT_INPUT', 'OPTIONAL_INPUT', 'BRACKET_INPUT', 'FIRST_INPUT', 'SECOND_INPUT',
            'FUNCTIONS_INPUT', 'FUNCTIONS_SECRET', 'FUNCTIONS_LIST', 'EMAIL_INPUT', 'BUILD_INPUT', 'DYNAMIC_INPUT',
            'WORKER_INPUT', 'STUDIO_INPUT', 'PYTHON_INPUT', 'SHELL_INPUT', 'WORDPRESS_INPUT', 'GITHUB_INPUT', 'GITHUB_SECRET', 'NAMESPACE_INPUT'}
        self.assertEqual(set(contract.configuration_reads(files)), expected)
        self.assertEqual(contract.violations(configuration(*expected), contract.configuration_reads(files)), [])

    def test_executable_module_and_jsx_reads_are_checked_and_declarations_are_excluded(self):
        for suffix in ['.mts', '.cts', '.jsx']:
            with self.subTest(suffix=suffix), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                subprocess.run(['git', 'init', '-q', str(root)], check=True)
                (root / f'runtime{suffix}').write_text('const value = process.env.MODULE_INPUT;')
                (root / 'runtime.d.mts').write_text('const value = process.env.DECLARATION_ONLY;')
                (root / 'runtime.d.cts').write_text('const value = process.env.DECLARATION_ONLY;')
                reads = contract.configuration_reads(contract.source_files(root))
                self.assertEqual(set(reads), {'MODULE_INPUT'})
                self.assertEqual(contract.violations(configuration('OTHER_INPUT'), reads), [
                    'missing supplier declaration: MODULE_INPUT', 'configured input has no code reader: OTHER_INPUT'])

    def test_missing_entry_and_dead_entry_are_independent_failures(self):
        self.assertEqual(contract.configuration_reads({'runtime.mjs': '// config-input: NOT_READ\nconst ordinary = 1;'}), {})
        self.assertEqual(contract.violations(configuration('OLD_INPUT'), {'NEW_INPUT': {'runtime.mjs'}}),
            ['missing supplier declaration: NEW_INPUT', 'configured input has no code reader: OLD_INPUT'])

    def test_supplier_deploy_step_and_unique_name_are_required(self):
        for mutation in ['supplier', 'scope', 'deployStep', 'duplicate', 'unknown', 'empty', 'missing']:
            value = configuration('INPUT')
            if mutation == 'duplicate':
                value['inputs'][0]['names'].append('INPUT')
            elif mutation == 'unknown':
                value['inputs'][0]['suppliers'] = ['undeclared']
            elif mutation == 'empty':
                value['inputs'][0]['suppliers'] = []
            elif mutation == 'missing':
                del value['inputs'][0]['suppliers']
            else:
                del value['suppliers']['configured-process'][mutation]
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                contract.configured_names(value)

    def test_process_boundary_refuses_missing_stale_or_invalid_declarations_without_values(self):
        with tempfile.TemporaryDirectory() as directory:
            # A checkout may live below a directory excluded inside that checkout.
            root = Path(directory) / 'tests' / 'checkout'
            root.mkdir(parents=True)
            subprocess.run(['git', 'init', '-q', str(root)], check=True)
            (root / 'config').mkdir()
            manifest = root / 'config/configuration-inputs.json'
            source = root / 'runtime.mjs'
            data = configuration('CONFIGURED_INPUT')
            manifest.write_text(json.dumps(data))
            source.write_text('export const value = process.env.CONFIGURED_INPUT;')
            def run():
                return subprocess.run(['python3', str(ROOT / 'scripts/check-configuration-inputs.py'), '--root', str(root)],
                    capture_output=True, text=True, timeout=10)
            self.assertEqual(run().returncode, 0)
            source.write_text('export const value = process.env.NEW_INPUT || "fixture-private-canary";')
            failed = run()
            self.assertEqual(failed.returncode, 1)
            self.assertIn('missing supplier declaration: NEW_INPUT', failed.stderr)
            self.assertIn('configured input has no code reader: CONFIGURED_INPUT', failed.stderr)
            self.assertNotIn('fixture-private-canary', failed.stdout + failed.stderr)
            manifest.write_text('not-json-fixture-private-canary')
            failed = run()
            self.assertEqual(failed.returncode, 1)
            self.assertIn('invalid supplier contract', failed.stderr)
            self.assertNotIn('fixture-private-canary', failed.stdout + failed.stderr)

    def test_process_boundary_inventories_astro(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(['git', 'init', '-q', str(root)], check=True)
            (root / 'config').mkdir()
            data = configuration('CONFIGURED_INPUT')
            (root / 'config/configuration-inputs.json').write_text(json.dumps(data))
            (root / 'runtime.mjs').write_text('export const value = process.env.CONFIGURED_INPUT;')
            source = root / 'component.astro'
            source.write_text('---\nconst required = import.meta.env.ASTRO_INPUT;\n---\n<div />')
            def run():
                return subprocess.run(['python3', str(ROOT / 'scripts/check-configuration-inputs.py'), '--root', str(root)],
                    capture_output=True, text=True, timeout=10)
            failed = run()
            self.assertEqual(failed.returncode, 1)
            self.assertIn('missing supplier declaration: ASTRO_INPUT', failed.stderr)
            source.unlink()
            self.assertEqual(run().returncode, 0)

    def test_process_boundary_refuses_unannotated_dynamic_reads(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(['git', 'init', '-q', str(root)], check=True)
            (root / 'config').mkdir()
            data = configuration('CONFIGURED_INPUT')
            (root / 'config/configuration-inputs.json').write_text(json.dumps(data))
            (root / 'runtime.mjs').write_text('export const value = process.env.CONFIGURED_INPUT;')
            def run():
                return subprocess.run(['python3', str(ROOT / 'scripts/check-configuration-inputs.py'), '--root', str(root)],
                    capture_output=True, text=True, timeout=10)
            source = root / 'worker.ts'
            for expression in ['env[key]', 'env?.[key]', 'process.env[key]', 'import.meta.env[key]', 'env[ "CONFIGURED_INPUT" + suffix ]', 'env [\n  key\n]', 'env ?. [key]']:
                with self.subTest(expression=expression):
                    source.write_text(f'const value = {expression}; // fixture-private-canary')
                    failed = run()
                    self.assertEqual(failed.returncode, 1)
                    self.assertIn('unannotated dynamic configuration read: worker.ts:1', failed.stderr)
                    self.assertNotIn('fixture-private-canary', failed.stdout + failed.stderr)
                    source.write_text(f'// config-input: CONFIGURED_INPUT\nconst value = {expression};')
                    self.assertEqual(run().returncode, 0)
            source.write_text('// config-input: CONFIGURED_INPUT\nconst first = env[key];\nconst second = env[otherKey];')
            self.assertIn('unannotated dynamic configuration read: worker.ts:3', run().stderr)
            source.write_text('// config-input: CONFIGURED_INPUT, OTHER_INPUT\nconst value = env[key];')
            self.assertIn('missing supplier declaration: OTHER_INPUT', run().stderr)
            source.write_text('// env[key]\n/* env[otherKey] */\nconst value = env[ "CONFIGURED_INPUT" ];\nconst profile = config.env[environment];')
            self.assertEqual(run().returncode, 0)

    def test_repository_inputs_have_suppliers_and_live_readers(self):
        result = subprocess.run(['python3', str(ROOT / 'scripts/check-configuration-inputs.py')],
            capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('no missing suppliers or stale readers', result.stdout)


if __name__ == '__main__':
    unittest.main()
