FROM node:22.22.1-bookworm-slim@sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d

LABEL org.opencontainers.image.title="fiducia-managed-beta-probe" \
      org.opencontainers.image.description="Bounded cumulative external SLI probe for the Fiducia managed public beta" \
      org.opencontainers.image.source="https://github.com/fiducia-cloud/fiducia-e2e" \
      org.opencontainers.image.licenses="UNLICENSED"

ENV NODE_ENV=production
WORKDIR /opt/fiducia-probe

COPY --chown=1000:1000 scripts/managed-beta-sli-probe.mjs ./managed-beta-sli-probe.mjs

USER 1000:1000
STOPSIGNAL SIGTERM
ENTRYPOINT ["node", "/opt/fiducia-probe/managed-beta-sli-probe.mjs"]
