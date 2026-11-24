import unittest
from unittest.mock import Mock

from api.dns import Route53Dns


class Route53DnsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.dns = Route53Dns.__new__(Route53Dns)
        self.dns.client = Mock()
        self.dns.client.get_hosted_zone.return_value = {
            "HostedZone": {"Name": "example.com."}
        }

    def test_upsert_rejects_names_outside_the_site(self) -> None:
        with self.assertRaisesRegex(ValueError, "site domain or one of its subdomains"):
            self.dns.upsert_record(
                "Z123",
                "example.com",
                "other.net",
                "A",
                300,
                ["192.0.2.1"],
            )
        self.dns.client.change_resource_record_sets.assert_not_called()

    def test_upsert_validates_address_family(self) -> None:
        with self.assertRaisesRegex(ValueError, "IPv4"):
            self.dns.upsert_record(
                "Z123",
                "example.com",
                "www.example.com",
                "A",
                300,
                ["2001:db8::1"],
            )
        self.dns.client.change_resource_record_sets.assert_not_called()

    def test_cname_target_is_normalized_and_must_be_a_domain(self) -> None:
        record = self.dns.upsert_record(
            "Z123",
            "example.com",
            "www.example.com",
            "CNAME",
            300,
            ["Target.Example.net"],
        )
        self.assertEqual(record["values"], ["target.example.net."])
        change = self.dns.client.change_resource_record_sets.call_args.kwargs
        self.assertEqual(
            change["ChangeBatch"]["Changes"][0]["ResourceRecordSet"]["ResourceRecords"],
            [{"Value": "target.example.net."}],
        )
        with self.assertRaisesRegex(ValueError, "fully qualified"):
            self.dns.upsert_record(
                "Z123",
                "example.com",
                "www.example.com",
                "CNAME",
                300,
                ["not-a-domain"],
            )

    def test_delete_uses_the_current_route53_record_set(self) -> None:
        self.dns.client.list_resource_record_sets.return_value = {
            "ResourceRecordSets": [
                {
                    "Name": "www.example.com.",
                    "Type": "A",
                    "TTL": 300,
                    "ResourceRecords": [{"Value": "192.0.2.1"}],
                }
            ],
            "IsTruncated": False,
        }

        self.assertTrue(self.dns.delete_record("Z123", "example.com", "www.example.com", "A"))
        request = self.dns.client.change_resource_record_sets.call_args.kwargs
        self.assertEqual(request["ChangeBatch"]["Changes"][0]["Action"], "DELETE")
        self.assertEqual(
            request["ChangeBatch"]["Changes"][0]["ResourceRecordSet"]["ResourceRecords"],
            [{"Value": "192.0.2.1"}],
        )


if __name__ == "__main__":
    unittest.main()
