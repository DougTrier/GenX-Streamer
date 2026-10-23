import datetime as dt
import gzip
import unittest
from unittest.mock import patch
from types import SimpleNamespace
import importlib.util
from pathlib import Path

_path = Path(__file__).resolve().parents[2] / 'scripts' / 'epg-source-audit.py'
_spec = importlib.util.spec_from_file_location('epg_source_audit', _path)
audit = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(audit)

NOW = dt.datetime(2026, 10, 12, 12, tzinfo=dt.timezone.utc)

def measure(body, limit=audit.EXPANDED):
    meter = audit.Meter(NOW, limit)
    decoder = audit.Decoder(meter)
    for index in range(0, len(body), 7):
        decoder.feed(body[index:index + 7])
    return decoder.finish()

def feed(start='20261012110000 +0000', stop='20261012130000 +0000', channel='a'):
    end = '' if stop is None else f' stop="{stop}"'
    return f'<tv><channel id="a"><display-name>A</display-name></channel><programme channel="{channel}" start="{start}"{end}><title>Actual title &amp; entity</title></programme></tv>'.encode()

class AuditTests(unittest.TestCase):
    def response(self, body, headers=None):
        class Response:
            status = 200
            def __init__(self):
                self.body = body
                self.length = len(body)
                self.headers = headers or {}
                self.fp = SimpleNamespace(raw=SimpleNamespace(_sock=SimpleNamespace(settimeout=lambda _: None)))
                self.closed = False
            def geturl(self):
                return 'https://example.org/final'
            def read1(self, count):
                data, self.body = self.body[:count], self.body[count:]
                self.length -= len(data)
                return data
            def __enter__(self):
                return self
            def __exit__(self, *args):
                self.closed = True
        return Response()

    def test_response_measurement_and_terms_separate_from_code_license(self):
        response = self.response(feed('20991012110000', '20991012130000'))
        with patch.object(audit.urllib.request, 'build_opener', return_value=SimpleNamespace(open=lambda *a, **kw: response)):
            result = audit.audit_one({'id': 'fixture', 'codeLicenseReported': 'GPL-3.0'}, 'https://example.org/source', audit.JobBudget())
        self.assertTrue(response.closed)
        self.assertEqual(result['operationalStatus'], 'Verified Active')
        self.assertEqual(result['classification'], 'Verified Active')
        self.assertTrue(result['responseComplete'])
        self.assertEqual(result['shaScope'], 'complete-response')
        self.assertNotIn('Actual title', str(result))

    def test_response_input_limit_whole_deadline_and_close(self):
        for kwargs, code in [({'PROFILES': {'diagnostic': (8, audit.EXPANDED)}}, 'input-limit'), ({'WHOLE': 0}, 'whole-deadline')]:
            response = self.response(feed())
            with patch.object(audit.urllib.request, 'build_opener', return_value=SimpleNamespace(open=lambda *a, **kw: response)), patch.multiple(audit, **kwargs):
                result = audit.audit_one({'id': 'fixture'}, 'https://example.org/source', audit.JobBudget())
            self.assertTrue(response.closed)
            self.assertEqual(result['reasonCode'], code)
            self.assertFalse(result['complete'])

    def test_http_initial_endpoint_never_opens_transport(self):
        with patch.object(audit.urllib.request, 'build_opener') as opener:
            result = audit.audit_one({'id': 'fixture'}, 'http://example.org/source', audit.JobBudget())
        opener.assert_not_called()
        self.assertEqual(result['reasonCode'], 'destination-refused')

    def test_http_truncation_cannot_publish_valid_xml_prefix(self):
        response = self.response(b'<tv/>')
        response.length += 100
        with patch.object(audit.urllib.request, 'build_opener', return_value=SimpleNamespace(open=lambda *a, **kw: response)):
            result = audit.audit_one({'id': 'fixture'}, 'https://example.org/source', audit.JobBudget())
        self.assertEqual(result['reasonCode'], 'body-truncated')
        self.assertFalse(result['responseComplete'])
        self.assertFalse(result['complete'])
        self.assertTrue(response.closed)

    def test_reserved_job_budget_never_reads_beyond_cap(self):
        response = self.response(feed())
        budget = audit.JobBudget(9)
        with patch.object(audit.urllib.request, 'build_opener', return_value=SimpleNamespace(open=lambda *a, **kw: response)):
            result = audit.audit_one({'id': 'fixture'}, 'https://example.org/source', budget)
        self.assertEqual(result['reasonCode'], 'job-byte-limit')
        self.assertEqual(result['inputBytes'], 9)
        self.assertEqual(budget.used, 9)
        reservation = audit.JobBudget(5)
        self.assertEqual(reservation.reserve(20), 5)
        reservation.refund(3)
        self.assertEqual(reservation.reserve(20), 3)
        self.assertEqual(reservation.used, 5)

    def test_declared_ids_and_known_future_end_are_distinct(self):
        result = measure(feed('20261013110000', None).replace(b'<channel id="a">', b'<channel id="unused"/><channel id="a">'))
        self.assertEqual(result['uniqueDeclaredChannelIdCount'], 2)
        self.assertEqual(result['usableChannelIdCount'], 1)
        self.assertEqual(result['futureProgramCount'], 1)
        self.assertEqual(result['knownEndFutureProgramCount'], 0)

    def test_http_error_is_closed_and_no_retry(self):
        class Body:
            closed = False
            def close(self):
                self.closed = True
        body = Body()
        error = audit.urllib.error.HTTPError('https://example.org/source', 429, '', {}, body)
        def fail(*a, **kw):
            raise error
        with patch.object(audit.urllib.request, 'build_opener', return_value=SimpleNamespace(open=fail)) as opener:
            result = audit.audit_one({'id': 'fixture'}, 'https://example.org/source', audit.JobBudget())
        self.assertEqual(result['httpStatus'], 429)
        self.assertEqual(result['reasonCode'], 'http-status')
        self.assertTrue(body.closed)
        self.assertEqual(opener.call_count, 1)

    def test_current_future_stale_and_empty(self):
        current = measure(feed())
        self.assertEqual(current['currentProgramCount'], 1)
        self.assertEqual(current['usableProgramCount'], 1)
        self.assertEqual(measure(feed('20261013110000', '20261013130000'))['futureProgramCount'], 1)
        stale = measure(feed('20261010110000', '20261010130000'))
        self.assertEqual(stale['currentProgramCount'] + stale['futureProgramCount'], 0)
        self.assertEqual(measure(b'<tv/>')['usableProgramCount'], 0)

    def test_gzip_strict_truncation_trailer_members(self):
        zipped = gzip.compress(feed())
        self.assertEqual(measure(zipped)['programCount'], 1)
        for invalid in (zipped[:-1], zipped + b'garbage'):
            with self.assertRaises((audit.Refusal, audit.zlib.error)):
                measure(invalid)
        self.assertEqual(measure(gzip.compress(b'<tv>') + gzip.compress(b'</tv>'))['programCount'], 0)

    def test_expansion_whole_refusal(self):
        with self.assertRaisesRegex(audit.Refusal, 'expanded-limit'):
            measure(gzip.compress(feed()), 40)

    def test_external_dtd_not_fetched_entity_declaration_refused(self):
        self.assertEqual(measure(b'<!DOCTYPE tv SYSTEM "https://private.invalid/secret"><tv/>')['programCount'], 0)
        for declaration in (b'<!DOCTYPE tv [<!ENTITY x "expanded">]><tv>&x;</tv>',
                            b'<!DOCTYPE tv [<!ENTITY x SYSTEM "file:///secret">]><tv>&x;</tv>'):
            with self.assertRaisesRegex(audit.Refusal, 'entity-declaration'):
                measure(declaration)

    def test_utf16_and_default_offset_utc(self):
        body = feed('20261012110000', '20261012130000').decode()
        result = measure(body.encode('utf-16'))
        self.assertEqual(result['missingOffsetTimestampCount'], 2)
        self.assertEqual(result['firstStart'], '2026-10-12T11:00:00Z')

    def test_timezone_and_invalid_timestamp(self):
        self.assertEqual(audit.instant('20261012163000 +0530')[0], audit.instant('20261012110000')[0])
        for text in ('202610', '20261012110000 EST', '20261012110000 +1460'):
            with self.assertRaises(ValueError):
                audit.instant(text)
        result = measure(feed('20261012110000 EST'))
        self.assertEqual(result['invalidTimestampCount'], 1)
        self.assertEqual(result['usableProgramCount'], 0)

    def test_missing_stop_dangling_reference_duplicate(self):
        self.assertEqual(measure(feed(stop=None))['missingEndCount'], 1)
        dangling = measure(feed(channel='unknown'))
        self.assertEqual(dangling['unknownChannelProgramCount'], 1)
        self.assertEqual(dangling['usableProgramCount'], 0)
        duplicate = measure(b'<tv><channel id="a"/><channel id="a"/></tv>')
        self.assertEqual(duplicate['duplicateChannelIdCount'], 1)

    def test_malformed_and_title_limit(self):
        with self.assertRaises(audit.xml.parsers.expat.ExpatError):
            measure(feed()[:-3])
        with self.assertRaisesRegex(audit.Refusal, 'title-limit'):
            measure(feed().replace(b'Actual title &amp; entity', b'x' * 16385))

    def test_public_dns_and_destination_refusal(self):
        resolver = lambda *a, **kw: [(2, 1, 6, '', ('8.8.8.8', 443))]
        self.assertEqual(audit.admit('https://example.org/a', resolver), ('example.org', '8.8.8.8'))
        for url in ('http://example.org/a', 'https://user:pass@example.org/a', 'https://example.org:444/a', 'https://example.org/a#x'):
            with self.assertRaises(audit.Refusal):
                audit.admit(url, resolver)
        for address in ('127.0.0.1', '10.0.0.1', '169.254.169.254', '::1'):
            with self.assertRaisesRegex(audit.Refusal, 'dns-nonpublic'):
                audit.admit('https://example.org/a', lambda *a, **kw: [(2, 1, 6, '', (address, 443))])

    def test_job_budget_exact_boundary(self):
        budget = audit.JobBudget(10)
        budget.take(10)
        with self.assertRaisesRegex(audit.Refusal, 'job-byte-limit'):
            budget.take(1)
        self.assertEqual(budget.used, 10)

    def test_29_documented_endpoints_not_truncated_101_refused(self):
        candidates = {'sources': [{'id': 'fixture', 'candidates': [f'https://example.org/{i}.xml' for i in range(29)]}]}
        with patch.object(audit, 'audit_one', side_effect=lambda source, endpoint, budget, profile: {'endpoint': endpoint}) as measured:
            report = audit.run(candidates)
        self.assertEqual(len(report['results']), 29)
        self.assertEqual(measured.call_count, 29)
        candidates['sources'][0]['candidates'] = [f'https://example.org/{i}.xml' for i in range(101)]
        with self.assertRaisesRegex(audit.Refusal, 'candidate-count'):
            audit.run(candidates)

    def test_profiles_are_fixed_production_bounds_not_unbounded_flags(self):
        self.assertEqual(audit.PROFILES, {'diagnostic': (8 * 1024 * 1024, 20 * 1024 * 1024), 'production': (20 * 1024 * 1024, 64 * 1024 * 1024)})
        with self.assertRaises(KeyError):
            audit.run({'sources': []}, 'unbounded')
        report = audit.run({'sources': []}, 'production')
        self.assertEqual(report['limits']['inputBytes'], 20 * 1024 * 1024)
        self.assertEqual(report['limits']['expandedBytes'], 64 * 1024 * 1024)
        self.assertEqual(report['limits']['jobBytes'], 200 * 1024 * 1024)
        self.assertEqual(report['limits']['wholeEndpointSeconds'], 45)

    def test_advertised_length_is_not_received_bytes_and_restriction_preserved(self):
        response = self.response(b'', {'Content-Length': str(9 * 1024 * 1024)})
        with patch.object(audit.urllib.request, 'build_opener', return_value=SimpleNamespace(open=lambda *a, **kw: response)):
            result = audit.audit_one({'id': 'fixture', 'status': 'Restricted'}, 'https://example.org/source', audit.JobBudget())
        self.assertEqual(result['advertisedContentLength'], 9 * 1024 * 1024)
        self.assertEqual(result['inputBytes'], 0)
        self.assertEqual(result['reasonCode'], 'input-limit')
        self.assertEqual(result['classification'], 'Restricted')
        self.assertEqual(result['operationalStatus'], 'Unverified')

    def test_no_xml_tree_or_text_retention(self):
        meter = audit.Meter(NOW)
        meter.feed(feed())
        meter.finish()
        self.assertIsNone(meter.program)
        self.assertEqual(meter.refs['a']['usable'], 1)
        self.assertFalse(any(isinstance(value, str) and 'Actual title' in value for value in meter.__dict__.values()))

if __name__ == '__main__':
    unittest.main()
