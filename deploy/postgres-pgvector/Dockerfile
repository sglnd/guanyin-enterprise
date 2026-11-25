# Keep the existing PostgreSQL major/minor and runtime base for PVC compatibility.
ARG BASE_IMAGE=postgres:17.6-alpine
FROM ${BASE_IMAGE} AS builder
RUN apk add --no-cache build-base
ADD --checksum=sha256:cac0b10c360f05b2d521200105ba3697e773d4cd3731f5a915a7e37ebe0bea85 https://codeload.github.com/pgvector/pgvector/tar.gz/refs/tags/v0.8.7 /tmp/pgvector.tar.gz
RUN tar -xzf /tmp/pgvector.tar.gz -C /tmp \
    && cd /tmp/pgvector-0.8.7 \
    && make with_llvm=no OPTFLAGS="" \
    && make with_llvm=no install
FROM ${BASE_IMAGE}
COPY --from=builder /usr/local/lib/postgresql/vector.so /usr/local/lib/postgresql/vector.so
COPY --from=builder /usr/local/share/postgresql/extension/vector* /usr/local/share/postgresql/extension/
COPY --from=builder /tmp/pgvector-0.8.7/LICENSE /usr/local/share/licenses/pgvector/LICENSE
LABEL io.guanyin.pgvector.version="0.8.7"
