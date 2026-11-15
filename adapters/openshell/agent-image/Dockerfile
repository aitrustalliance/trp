# The scripted agent's image for record.sh. OpenShell's default sandbox image,
# pinned by the digest the first recording pulled, with curl added, since the
# default image ships no HTTP client. OpenShell replaces the command with its
# sandbox supervisor. The Docker driver runs the agent as the image's USER and
# refuses UID or GID 0, so the image ends on 1000, the driver's own default.
FROM nvcr.io/nvidia/base/ubuntu:24.04@sha256:fef8f2708dbb85fbfcba6503d805397d89d9210f375362ff3b9f7888eb297ca5
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
USER 1000:1000
