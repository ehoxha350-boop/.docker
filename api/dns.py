import ipaddress
import re
from typing import Any

import boto3


RECORD_TYPES = {"A", "AAAA", "CNAME", "TXT"}
ZONE_ID_PATTERN = re.compile(r"^(?:/hostedzone/)?[A-Z0-9-]+$")


class Route53Dns:
    def __init__(self) -> None:
        self.client = boto3.client("route53")

    @staticmethod
    def _zone_id(value: str) -> str:
        if not ZONE_ID_PATTERN.fullmatch(value):
            raise ValueError("Invalid Route 53 hosted zone ID")
        return value.removeprefix("/hostedzone/")

    def _zone_name(self, zone_id: str) -> str:
        zone = self.client.get_hosted_zone(Id=self._zone_id(zone_id))["HostedZone"]["Name"]
        return zone.rstrip(".").lower()

    def _validate_site_scope(self, zone_id: str, domain: str, record_name: str) -> str:
        zone_name = self._zone_name(zone_id)
        if domain != zone_name and not domain.endswith(f".{zone_name}"):
            raise ValueError("Hosted zone does not own this site's domain")
        normalized = record_name.rstrip(".").lower()
        if normalized != domain and not normalized.endswith(f".{domain}"):
            raise ValueError("DNS record name must be the site domain or one of its subdomains")
        return normalized + "."

    def list_records(self, zone_id: str, domain: str) -> list[dict[str, Any]]:
        zone_name = self._zone_name(zone_id)
        if domain != zone_name and not domain.endswith(f".{zone_name}"):
            raise ValueError("Hosted zone does not own this site's domain")
        records: list[dict[str, Any]] = []
        request: dict[str, Any] = {"HostedZoneId": self._zone_id(zone_id)}
        while True:
            page = self.client.list_resource_record_sets(**request)
            for record in page["ResourceRecordSets"]:
                record_type = record["Type"]
                if (
                    record_type not in RECORD_TYPES
                    or "ResourceRecords" not in record
                    or "SetIdentifier" in record
                ):
                    continue
                name = record["Name"].rstrip(".").lower()
                if name != domain and not name.endswith(f".{domain}"):
                    continue
                records.append(
                    {
                        "name": name,
                        "type": record_type,
                        "ttl": record["TTL"],
                        "values": [value["Value"] for value in record["ResourceRecords"]],
                    }
                )
            if not page.get("IsTruncated"):
                break
            request = {
                "HostedZoneId": self._zone_id(zone_id),
                "StartRecordName": page["NextRecordName"],
                "StartRecordType": page["NextRecordType"],
            }
            if page.get("NextRecordIdentifier"):
                request["StartRecordIdentifier"] = page["NextRecordIdentifier"]
        return records

    def upsert_record(
        self,
        zone_id: str,
        domain: str,
        name: str,
        record_type: str,
        ttl: int,
        values: list[str],
    ) -> dict[str, Any]:
        if record_type not in RECORD_TYPES:
            raise ValueError("Supported record types are A, AAAA, CNAME, and TXT")
        if not values or len(values) > 20 or any(not value or len(value) > 255 for value in values):
            raise ValueError("Provide between 1 and 20 non-empty values of at most 255 characters")
        fqdn = self._validate_site_scope(zone_id, domain, name)
        if record_type == "A":
            for value in values:
                if ipaddress.ip_address(value).version != 4:
                    raise ValueError("A records require IPv4 addresses")
        elif record_type == "AAAA":
            for value in values:
                if ipaddress.ip_address(value).version != 6:
                    raise ValueError("AAAA records require IPv6 addresses")
        elif record_type == "CNAME":
            if len(values) != 1:
                raise ValueError("CNAME records require exactly one value")
            if fqdn.rstrip(".") == self._zone_name(zone_id):
                raise ValueError("A zone apex cannot be a CNAME")
            values = [self._normalize_target(values[0])]

        record_set = {
            "Name": fqdn,
            "Type": record_type,
            "TTL": ttl,
            "ResourceRecords": [{"Value": value} for value in values],
        }
        self.client.change_resource_record_sets(
            HostedZoneId=self._zone_id(zone_id),
            ChangeBatch={"Changes": [{"Action": "UPSERT", "ResourceRecordSet": record_set}]},
        )
        return {
            "name": fqdn.rstrip("."),
            "type": record_type,
            "ttl": ttl,
            "values": values,
        }

    @staticmethod
    def _normalize_target(value: str) -> str:
        try:
            target = value.rstrip(".").encode("idna").decode("ascii").lower()
        except UnicodeError as error:
            raise ValueError("CNAME value must be a fully qualified domain name") from error
        labels = target.split(".")
        if len(target) > 253 or len(labels) < 2 or any(
            not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
            for label in labels
        ):
            raise ValueError("CNAME value must be a fully qualified domain name")
        return target + "."

    def delete_record(self, zone_id: str, domain: str, name: str, record_type: str) -> bool:
        if record_type not in RECORD_TYPES:
            raise ValueError("Only A, AAAA, CNAME, and TXT records can be deleted here")
        fqdn = self._validate_site_scope(zone_id, domain, name)
        for record in self.list_records(zone_id, domain):
            if record["name"] == fqdn.rstrip(".") and record["type"] == record_type:
                self.client.change_resource_record_sets(
                    HostedZoneId=self._zone_id(zone_id),
                    ChangeBatch={
                        "Changes": [
                            {
                                "Action": "DELETE",
                                "ResourceRecordSet": {
                                    "Name": fqdn,
                                    "Type": record["type"],
                                    "TTL": record["ttl"],
                                    "ResourceRecords": [{"Value": value} for value in record["values"]],
                                },
                            }
                        ]
                    },
                )
                return True
        return False
