#!/usr/bin/env python3
"""Check current configuration reads against their declared suppliers."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import sys

SUFFIXES = {'.astro', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx', '.sh', '.py', '.php', '.yml', '.yaml', '.json', '.jsonc', '.toml', '.ps1'}
SKIP_PARTS = {'tests', 'test', 'fixtures', '__tests__', 'node_modules', 'dist', '.git', '.astro', 'coverage'}
NAME = r'[A-Z][A-Za-z0-9_]*'
DYNAMIC_ACCESS = re.compile(r'(?<![\w.])(?:process\.env|import\.meta\.env|env|environment|deploymentEnv)\s*(?:\?\.\s*)?\[([^]]+)\]')


class DynamicReadError(ValueError):
    pass

READ_PATTERNS = [
    rf'\b(?:process\.env|import\.meta\.env|env|environment|deploymentEnv)(?:\?\.|\.)({NAME})\b',
    rf'\b(?:process\.env|import\.meta\.env|env|environment|deploymentEnv)\s*(?:\?\.\s*)?\[\s*["\']({NAME})["\']\s*\]',
    rf'\b(?:defineString|defineSecret|defineList|defineInt|defineBoolean|getenv|deploymentEmail)\(\s*["\']({NAME})["\']',
    rf'\bos\.(?:environ\.get|getenv)\(\s*["\']({NAME})["\']',
    rf'\bos\.environ\[\s*["\']({NAME})["\']\s*\]',
    rf'\b(?:vars|secrets)\.({NAME})\b',
    rf'\$env:({NAME})\b',
    rf'\bloadEnv\([^\n]*?,\s*["\']({NAME})["\']\s*\)',
]


def without_comments(source, suffix):
    output = []
    index = 0
    quote = None
    hash_comments = suffix in {'.py', '.sh', '.php', '.yml', '.yaml', '.toml', '.ps1'}
    slash_comments = suffix not in {'.py', '.sh', '.yml', '.yaml', '.toml', '.ps1'}
    while index < len(source):
        char = source[index]
        if quote:
            output.append(char)
            if char == "\\" and index + 1 < len(source):
                index += 1
                output.append(source[index])
            elif char == quote:
                quote = None
            index += 1
            continue
        if char in {"\"", "'", "`"}:
            quote = char
        elif (hash_comments and char == '#') or (slash_comments and source[index:index + 2] == '//'):
            start = index
            end = source.find('\n', index)
            index = len(source) if end == -1 else end
            output.append(' ' * (index - start))
            continue
        elif slash_comments and source[index:index + 2] == '/*':
            start = index
            end = source.find('*/', index + 2)
            index = len(source) if end == -1 else end + 2
            output.append(re.sub(r'[^\n]', ' ', source[start:index]))
            continue
        output.append(char)
        index += 1
    return ''.join(output)


def configuration_reads(files):
    """Return names only; source values never become diagnostics or input data."""
    found = {}
    issues = []
    for filename, source in sorted(files.items()):
        path = Path(filename)
        if (path.suffix not in SUFFIXES or set(path.parts) & SKIP_PARTS
                or re.search(r'\.(?:test|spec)\.', path.name) or '.d.' in path.name
                or any(part.startswith('.cross-model-review-') for part in path.parts)
                or path.parts[:3] == ('admin', 'src', 'dev')):
            continue
        if not re.search(r'process\.env|import\.meta\.env|\b(?:env|environment|deploymentEnv|vars|secrets)\s*[.?\[]|\b(?:defineString|defineSecret|defineList|defineInt|defineBoolean|getenv|deploymentEmail|loadEnv)\(|os\.environ|os\.getenv|config-input:|\$\{|\$env:', source):
            continue
        source_lines = source.splitlines()
        source = without_comments(source, path.suffix)
        annotations = set()
        for read in DYNAMIC_ACCESS.finditer(source):
            if re.fullmatch(rf'\s*([\"\']){NAME}\1\s*', read.group(1)):
                continue
            line = source.count('\n', 0, read.start())
            declared = set()
            for previous in reversed(source_lines[:line]):
                annotation = re.fullmatch(rf'\s*(?:#|//)\s*config-input:\s*({NAME}(?:\s*,\s*{NAME})*)\s*', previous)
                if not annotation:
                    break
                declared.update(re.findall(NAME, annotation.group(1)))
            if not declared:
                issues.append(f'unannotated dynamic configuration read: {filename}:{line + 1}')
            annotations.update(declared)
        names = annotations | {name for pattern in READ_PATTERNS for name in re.findall(pattern, source)}
        for body in re.findall(r'\{([^{}]+)\}\s*=\s*(?:process\.env|env|environment)\b', source):
            names.update(re.findall(rf'\b({NAME})\b(?=\s*[:,=}}]|\s*$)', body))
        if path.suffix == '.sh':
            local_names = set(re.findall(rf'^\s*(?:(?:readonly|local|declare)\s+)?({NAME})=', source, re.M))
            for name in re.findall(rf'\$\{{({NAME})(?:[:?+\-][^}}]*)?\}}', source):
                if name not in local_names or re.search(rf'\b{name}=.*\$\{{{name}[:?+\-]', source):
                    names.add(name)
        elif 'wrangler' in path.name:
            names.update(re.findall(rf'\$\{{({NAME})\}}', source))
        for name in names:
            found.setdefault(name, set()).add(filename)
    if issues:
        raise DynamicReadError('\n'.join(sorted(set(issues))))
    return found


def source_files(root):
    names = subprocess.check_output(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd=root).decode().split('\0')
    files = {}
    for name in set(names) - {''}:
        path = root / name
        if path.suffix in SUFFIXES and not path.is_symlink() and path.is_file() and not set(Path(name).parts) & SKIP_PARTS:
            files[name] = path.read_text(encoding='utf-8')
    return files


def configured_names(config):
    if not isinstance(config, dict) or set(config) != {'suppliers', 'inputs'}:
        raise ValueError('invalid configuration input contract')
    suppliers = config['suppliers']
    if not isinstance(suppliers, dict) or not suppliers:
        raise ValueError('missing suppliers')
    for supplier in suppliers.values():
        if (not isinstance(supplier, dict) or set(supplier) != {'supplier', 'scope', 'deployStep'}
                or any(not isinstance(value, str) or not value.strip() for value in supplier.values())):
            raise ValueError('missing supplier, scope or deploy step')
    if not isinstance(config['inputs'], list):
        raise ValueError('invalid input groups')
    names = set()
    for group in config['inputs']:
        if (not isinstance(group, dict) or set(group) != {'suppliers', 'names'}
                or not isinstance(group['suppliers'], list) or not group['suppliers']
                or any(not isinstance(step, str) or step not in suppliers for step in group['suppliers'])
                or not isinstance(group['names'], list) or not group['names']):
            raise ValueError('input group requires declared suppliers and names')
        for name in group['names']:
            if not isinstance(name, str) or not re.fullmatch(NAME, name) or name in names:
                raise ValueError('invalid or duplicate configured name')
            names.add(name)
    return names


def violations(config, reads):
    names = configured_names(config)
    return ([f'missing supplier declaration: {name}' for name in sorted(reads.keys() - names)] +
            [f'configured input has no code reader: {name}' for name in sorted(names - reads.keys())])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    try:
        config = json.loads((args.root / 'config/configuration-inputs.json').read_text())
        issues = violations(config, configuration_reads(source_files(args.root)))
        if issues:
            print('\n'.join(issues), file=sys.stderr)
            return 1
        print(f'configuration inputs: {len(configured_names(config))} names, no missing suppliers or stale readers')
        return 0
    except DynamicReadError as error:
        print(str(error), file=sys.stderr)
        return 1
    except (ValueError, TypeError, KeyError, OSError, subprocess.SubprocessError):
        print('configuration inputs: invalid supplier contract or unreadable source inventory', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
