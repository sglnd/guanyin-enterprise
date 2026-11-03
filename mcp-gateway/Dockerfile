FROM golang:1.25-alpine AS build
WORKDIR /src
COPY mcp-gateway/go.mod mcp-gateway/go.sum ./
RUN go mod download
COPY mcp-gateway/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /gateway .
FROM alpine:3.22
RUN apk add --no-cache ca-certificates
COPY --from=build /gateway /gateway
USER 10001:10001
EXPOSE 8080 8081
ENTRYPOINT ["/gateway"]
