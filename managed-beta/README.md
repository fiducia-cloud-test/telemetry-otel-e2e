# Managed-beta external probe test-fleet scenario

This test-org-only scenario exercises the Fiducia managed-beta availability
source package without claiming that synthetic GitHub Actions runners are real
failure-independent production locations.

## Private-source and package boundary

The `fiducia-cloud-test` Actions token intentionally cannot read the private
production repositories or private GHCR package. This harness does not weaken
that boundary and does not embed a cross-org PAT.

Instead, the test repository vendors exact reviewed blobs and verifies their Git
blob identities before execution:

- the probe script and digest-pinned Dockerfile from production source commit
  `596449565cd2ec466ff72a533e8190ce389b4149`;
- the production Prometheus rules from
  `fiducia-infra@d22740b98a08dea6a30ca364c90ebd59c965b557`.

The probe image is built locally from those exact blobs. The published production
artifact remains recorded for deployment work:

```text
ghcr.io/fiducia-cloud/fiducia-managed-beta-probe@sha256:cc251cb82f131616e73c070929f4dd9066228d1a90e86c627933f787e63e0941
```

This test validates source/runtime equivalence, not registry ACLs or the
published manifest itself.

The production exporter is pinned by merge commit and blob identity but is not
loaded by the test-org runner. Its own production CI validates the exporter. A
small test-fleet-only checker independently asserts the integrated monitoring
policy and emits a summary that explicitly has no production maturity effect.

## Scenario

The workflow uses:

- the locally built, non-root probe image from exact production source blobs;
- two isolated cumulative state directories and trusted scrape-injected
  `probe_location` labels;
- exact vendored production Prometheus recording/alert rules;
- a deliberate duplicate scrape authority;
- an operation-specific stale `secret_read` source while `health` remains fresh;
- a 28-day policy with deliberately short synthetic history.

It proves:

1. the probe image runs non-root and produces cumulative, endpoint-redacted
   textfile metrics without self-asserting `probe_location`;
2. central Prometheus injects two trusted location identities;
3. fresh-location counts are operation-specific, so a fresh `health` probe cannot
   hide a stale `secret_read` source;
4. duplicate scrape authority is observable;
5. short history, stale source state, and duplicate authority make the synthetic
   measurement incomplete;
6. counter-reset checks remain clean for fresh state;
7. the bounded test-fleet summary excludes fixture canaries and endpoints.

A green run is **test-fleet automation only**. It does not move DEN-1619 to
`instrumented`, `queryable`, or `measured`, because both probe locations run on
one disposable GitHub Actions host and share its physical host, network,
scheduler, and failure domain.
