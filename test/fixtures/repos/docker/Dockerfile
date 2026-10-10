FROM python:3.13-slim@sha256:bf44cdfcb76cd3b41e879bc058fc37ec5872002ccfde7fcb765e218cde0cd79c
# ENV MODEL=gpt-fixture-3
ENV MODEL=gpt-fixture-retired
ENV OTHER_MODEL claude-fixture-opus-9
ARG BUILD_MODEL=$DEFAULT_MODEL
RUN python -m app --model gpt-fixture-2-2099-02-15
