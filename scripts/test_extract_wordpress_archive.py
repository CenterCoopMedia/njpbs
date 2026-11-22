import io
import json
from pathlib import Path
import stat
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest

from extract_wordpress_archive import READ_SIZE, extract


SCRIPT = Path(__file__).with_name("extract_wordpress_archive.py")
FIXTURE = SCRIPT.parent / "fixtures" / "wordpress-archive.xml"


def run_extract(source, output=None):
    command = [sys.executable, str(SCRIPT), str(source), "--source", "example-news"]
    if output:
        command.extend(["--output", str(output)])
    return subprocess.run(command, capture_output=True, text=True, check=False)


class BoundedInput(io.BytesIO):
    def read(self, size=-1):
        if not 0 < size <= READ_SIZE:
            raise AssertionError("The extractor must request a bounded read.")
        return super().read(min(size, 113))


class WordPressArchiveTest(unittest.TestCase):
    def test_extracts_staged_records_and_reports_unmappable_items(self):
        with TemporaryDirectory() as directory:
            target = Path(directory) / "archive.ndjson"
            dry_run = run_extract(FIXTURE)
            result = run_extract(FIXTURE, target)
            self.assertEqual((dry_run.returncode, result.returncode), (0, 0), result.stderr)
            self.assertEqual(dry_run.stdout, result.stdout)
            self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)
            text = target.read_text(encoding="utf-8")
            header, author, story, attachment, future, skipped, restricted, summary = [
                json.loads(line) for line in text.splitlines()
            ]
            self.assertEqual(header, {
                "kind": "header", "format": "wordpress-archive", "version": 1,
                "source": "example-news",
            })
            self.assertEqual(summary, json.loads(result.stdout))
            self.assertEqual(summary["counts"], {"story": 2, "author": 1, "attachment": 1, "unmappable": 2})
            self.assertEqual((author["login"], author["displayName"]), ("reporter", "Archive Reporter"))
            self.assertEqual((story["postId"], story["authorLogin"]), ("62", author["login"]))
            self.assertEqual(story["title"], "Transit & the café")
            self.assertEqual(story["permalink"], "https://example.org/2020/05/transit/")
            self.assertEqual(story["postDateUtc"], "2020-05-01T12:00:00Z")
            self.assertEqual(story["revision"]["modifiedAt"], "2020-05-02T17:00:00Z")
            self.assertEqual(story["html"], "<!-- wp:paragraph --><p>A &amp; B.</p><!-- /wp:paragraph -->")
            self.assertEqual(story["excerpt"], "Story summary.")
            self.assertEqual(story["taxonomy"], [
                {"taxonomy": "category", "slug": "transit", "label": "Transit"},
                {"taxonomy": "post_tag", "slug": "rail", "label": "Rail"},
            ])
            self.assertEqual(story["featuredAttachmentId"], attachment["postId"])
            self.assertEqual(attachment["parentPostId"], story["postId"])
            self.assertEqual(attachment["attachmentUrl"], "https://example.org/uploads/train.jpg")
            self.assertEqual([row["lifecycle"] for row in (story, attachment, future)], ["staged"] * 3)
            self.assertEqual((story["sourceStatus"], future["sourceStatus"]), ("publish", "future"))
            self.assertIsNone(future["postDateUtc"])
            self.assertIsNone(future["revision"]["modifiedAt"])
            self.assertEqual(skipped, {
                "kind": "unmappable", "entity": "item", "ordinal": 5, "reason": "unsupported-post-type",
            })
            self.assertEqual(restricted["reason"], "password-protected-item")
            for omitted in ("reporter@example.org", "Unrelated comment", "example-only", "Restricted body"):
                self.assertNotIn(omitted, text)

    def test_revision_changes_with_content_and_keeps_source_identity(self):
        source = FIXTURE.read_bytes()

        def extract_story(data):
            output = io.StringIO()
            extract(BoundedInput(data), "example-news", output)
            return json.loads(output.getvalue().splitlines()[2])

        original = extract_story(source)
        self.assertEqual(original, extract_story(source.replace(
            b"http://wordpress.org/export/", b"https://wordpress.org/export/",
        )))
        updated = extract_story(source.replace(b"A &amp; B.", b"A &amp; C."))
        self.assertEqual(original["postId"], updated["postId"])
        self.assertEqual(original["revision"]["modifiedAt"], updated["revision"]["modifiedAt"])
        self.assertNotEqual(original["revision"]["sha256"], updated["revision"]["sha256"])

    def test_reports_oversized_item_and_reads_the_next_item(self):
        source = FIXTURE.read_bytes().replace(b"A &amp; B.", b"x" * (2 * 1024 * 1024))
        output = io.StringIO()
        summary = extract(BoundedInput(source), "example-news", output)
        rows = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(rows[2]["reason"], "record-limit")
        self.assertEqual(rows[3]["postId"], "63")
        self.assertEqual(summary["counts"]["story"], 1)

    def test_failed_export_leaves_no_packet_and_existing_output_is_preserved(self):
        fixture = FIXTURE.read_bytes()
        with TemporaryDirectory() as directory:
            directory = Path(directory)
            source = directory / "invalid.xml"
            target = directory / "archive.ndjson"
            failures = (
                (fixture.removesuffix(b"</rss>\n"), "Invalid XML at line"),
                (b'<!DOCTYPE rss SYSTEM "https://example.org/extern.dtd">' + fixture.split(b"\n", 1)[1],
                 "XML document types are unsupported"),
            )
            for data, message in failures:
                with self.subTest(message=message):
                    source.write_bytes(data)
                    result = run_extract(source, target)
                    self.assertEqual(result.returncode, 1)
                    self.assertIn(message, result.stderr)
                    self.assertEqual(result.stdout, "")
                    self.assertFalse(target.exists())
                    self.assertEqual(list(directory.iterdir()), [source])
            target.write_text("existing packet", encoding="ascii")
            result = run_extract(FIXTURE, target)
            self.assertEqual(result.returncode, 1)
            self.assertIn("already exists", result.stderr)
            self.assertEqual(target.read_text(encoding="ascii"), "existing packet")


if __name__ == "__main__":
    unittest.main()
