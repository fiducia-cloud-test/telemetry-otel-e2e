# Managed-beta external probe test-fleet scenario

This test-org-only scenario exercises the Fiducia managed-beta availability
source package without claiming that synthetic GitHub Actions runners are real
failure-independent production locations.

It uses:

- the published, digest-pinned probe OCI image;
- two isolated cumulative state directories and trusted scrape-injected
  `probe_location` labels;
- the production Prometheus recording/alert rules pinned from `fiducia-infra`;
- the production exact-candidate evidence exporter pinned from `fiducia-e2e`;
- a deliberate duplicate scrape authority and an operation-specific stale source.

The workflow proves:

1. the probe image runs non-root and produces cumulative, endpoint-redacted
   textfile metrics without self-asserting `probe_location`;
2. central Prometheus injects two trusted location identities;
3. fresh-location counts are operation-specific, so a fresh `health` probe cannot
   hide a stale `secret_read` source;
4. duplicate scrape authority is observable;
5. the evidence exporter remains incomplete for synthetic short history,
   duplicate authority, or stale sources;
6. evidence output remains bounded and excludes fixture canaries and endpoints.

A green run is **test-fleet automation only**. It does not move DEN-1619 to
`instrumented`, `queryable`, or `measured`, because both probe locations run on
one disposable GitHub Actions host and share its network and scheduler failure
domain.
