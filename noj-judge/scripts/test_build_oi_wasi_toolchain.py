"""固定下载摘要与已验证归档封装的回归，不访问网络。"""
import hashlib
import gzip
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location(
    'toolchain_build', Path(__file__).with_name('build-oi-wasi-toolchain.py'))
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class DownloadTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.source = self.root / 'source.gz'
        self.source.write_bytes(b'fixed archive encoding')
        self.expected = hashlib.sha256(self.source.read_bytes()).hexdigest()
        self.output = self.root / 'cached.tar.gz'

    def tearDown(self):
        self.directory.cleanup()

    def test_exact_source_and_cache(self):
        self.assertEqual(builder.download(self.source.as_uri(), self.expected, self.output), self.expected)
        self.source.unlink()
        self.assertEqual(builder.download(self.source.as_uri(), self.expected, self.output), self.expected)

    def test_pinned_alternate_encoding(self):
        self.assertEqual(builder.download(self.source.as_uri(), '0' * 64, self.output, [self.expected]), self.expected)

    def test_unknown_encoding_is_rejected_and_removed(self):
        with self.assertRaisesRegex(RuntimeError, '来源摘要不匹配'):
            builder.download(self.source.as_uri(), '0' * 64, self.output)
        self.assertFalse(self.output.exists())
        self.assertFalse(self.output.with_suffix('.download').exists())

    def test_alternate_archive_cannot_record_a_new_manifest(self):
        args = SimpleNamespace(cache=self.root / 'cache', work=self.root / 'work',
                               output=self.root / 'output', jobs=2,
                               record_manifest=self.root / 'manifest.json')
        with patch.object(builder, 'download', return_value='b4525499be9ccd65a0da8c9efbeb59a5955130b302a190a51883727d8c5c7542'):
            with self.assertRaisesRegex(RuntimeError, '禁止用于重新记录'):
                builder.build(args)
        self.assertFalse(args.record_manifest.exists())

    def test_tampered_cache_is_replaced(self):
        self.output.write_bytes(b'tampered')
        builder.download(self.source.as_uri(), self.expected, self.output)
        self.assertEqual(self.output.read_bytes(), self.source.read_bytes())

    def gzip_options(self, content):
        return {'gzip_checksum': hashlib.sha256(content).hexdigest(), 'gzip_size': len(content)}

    def test_new_compression_requires_identical_uncompressed_bytes(self):
        content = b'fixed tar bytes' * 100
        self.source.write_bytes(gzip.compress(content, compresslevel=1, mtime=123))
        raw = builder.download(self.source.as_uri(), '0' * 64, self.output,
                               **self.gzip_options(content))
        self.assertEqual(raw, builder.digest(self.source))
        self.source.unlink()
        self.assertEqual(builder.download('file:///unavailable', '0' * 64, self.output,
                                         **self.gzip_options(content)), raw)

    def test_changed_source_is_rejected_even_with_equal_size(self):
        self.source.write_bytes(gzip.compress(b'changed source', mtime=0))
        with self.assertRaisesRegex(RuntimeError, '来源摘要不匹配'):
            builder.download(self.source.as_uri(), '0' * 64, self.output,
                             **self.gzip_options(b'pinned! source'))
        self.assertFalse(self.output.exists())
        self.assertFalse(self.output.with_suffix('.download').exists())

    def test_truncated_gzip_is_rejected_and_removed(self):
        content = b'fixed tar'
        self.source.write_bytes(gzip.compress(content, mtime=0)[:-4])
        with self.assertRaisesRegex(RuntimeError, '来源摘要不匹配'):
            builder.download(self.source.as_uri(), '0' * 64, self.output,
                             **self.gzip_options(content))
        self.assertFalse(self.output.with_suffix('.download').exists())

    def test_decompressed_size_is_bounded(self):
        self.source.write_bytes(gzip.compress(b'x' * (2 * 1024 * 1024), mtime=0))
        with self.assertRaisesRegex(RuntimeError, '来源摘要不匹配'):
            builder.download(self.source.as_uri(), '0' * 64, self.output,
                             **self.gzip_options(b'x'))
        self.assertFalse(self.output.with_suffix('.download').exists())

    def test_invalid_gzip_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, '来源摘要不匹配'):
            builder.download(self.source.as_uri(), '0' * 64, self.output,
                             **self.gzip_options(b'fixed tar'))
        self.assertFalse(self.output.with_suffix('.download').exists())

    def test_content_digest_requires_size(self):
        with self.assertRaisesRegex(RuntimeError, '必须同时提供'):
            builder.download(self.source.as_uri(), self.expected, self.output,
                             gzip_checksum=self.expected)


if __name__ == '__main__':
    unittest.main()
