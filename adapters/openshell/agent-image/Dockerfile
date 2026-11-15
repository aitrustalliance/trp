# The scripted agent's image for record.sh. OpenShell's default sandbox image,
# pinned by the digest the first recording pulled, with curl added, since the
# default image ships no HTTP client. OpenShell replaces the command with its
# sandbox supervisor and keeps the image's sandbox user.
FROM nvcr.io/nvidia/base/ubuntu:24.04@sha256:fef8f2708dbb85fbfcba6503d805397d89d9210f375362ff3b9f7888eb297ca5
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
