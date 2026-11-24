import tempfile
import unittest
from pathlib import Path

from api.cms import CmsStore, make_slug


class CmsStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.store = CmsStore(str(Path(self.temp_dir.name) / "sites.db"))
        self.site = self.store.create_site("Example", "example.com", "Z123")

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_posts_publish_and_only_published_posts_are_public(self) -> None:
        draft = self.store.create_post(self.site["id"], "A Draft", "a-draft", "Draft body", "draft")
        self.assertIsNone(self.store.get_public_post(self.site["id"], draft["slug"]))

        published = self.store.update_post(
            draft["id"], "A Draft", "a-draft", "Published body", "published"
        )
        self.assertEqual(published["status"], "published")
        self.assertIsNotNone(published["published_at"])
        public_post = self.store.get_public_post(self.site["id"], "a-draft")
        self.assertEqual(public_post["body"], "Published body")

        self.store.update_post(draft["id"], "A Draft", "a-draft", "Draft again", "draft")
        self.assertIsNone(self.store.get_public_post(self.site["id"], "a-draft"))

    def test_site_delete_cascades_and_tracking_is_per_site(self) -> None:
        second_site = self.store.create_site("Another", "another.com", None)
        settings = {
            "gtm_id": "GTM-ABC1",
            "ga4_id": "G-ABC1",
            "meta_pixel_id": "",
            "tiktok_pixel_id": "",
        }
        saved = self.store.save_tracking(self.site["id"], settings)
        self.assertEqual(saved["ga4_id"], "G-ABC1")
        self.assertEqual(self.store.get_tracking(second_site["id"])["ga4_id"], "")

        self.store.create_post(self.site["id"], "Post", "post", "Body", "published")
        self.assertTrue(self.store.delete_site(self.site["id"]))
        self.assertEqual(self.store.list_posts(self.site["id"]), [])
        self.assertIsNone(self.store.get_public_post(self.site["id"], "post"))

    def test_slug_generation_handles_empty_and_unicode_titles(self) -> None:
        self.assertEqual(make_slug("Hello, World!"), "hello-world")
        self.assertEqual(make_slug("你好"), "post")


if __name__ == "__main__":
    unittest.main()
