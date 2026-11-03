package main

import (
	"bufio"
	"context"
	"encoding/base64"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"time"
)

func origin(scheme, authority string) (string, string, error) {
	u, e := url.Parse(scheme + "://" + authority)
	if e != nil || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" {
		return "", "", errors.New("invalid authority")
	}
	host := strings.ToLower(u.Hostname())
	port := u.Port()
	if port == "" {
		if scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}
	n, e := strconv.Atoi(port)
	if e != nil || n < 1 || n > 65535 {
		return "", "", errors.New("invalid port")
	}
	addr := net.JoinHostPort(host, strconv.Itoa(n))
	return scheme + "://" + addr, addr, nil
}
func permittedOrigin(s *snapshot, space, want string) bool {
	for _, v := range s.Origins[space] {
		u, e := url.Parse(v)
		if e == nil {
			canonical, _, e := origin(u.Scheme, u.Host)
			if e == nil && canonical == want {
				return true
			}
		}
	}
	return false
}
func proxyDial(ctx context.Context, addr string) (net.Conn, error) {
	host, port, e := net.SplitHostPort(addr)
	if e != nil {
		return nil, e
	}
	ips, e := net.DefaultResolver.LookupIPAddr(ctx, host)
	if e != nil || len(ips) == 0 {
		return nil, errors.New("dns_failed")
	}
	for _, a := range ips {
		ip := a.IP
		if ip.IsLoopback() || ip.IsUnspecified() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast() {
			return nil, errors.New("unsafe_destination")
		}
	}
	// Private IPs require an exact origin grant; pin this connection to the resolved IP.
	var last error
	for _, a := range ips {
		c, e := (&net.Dialer{Timeout: 10 * time.Second}).DialContext(ctx, "tcp", net.JoinHostPort(a.IP.String(), port))
		if e == nil {
			return c, nil
		}
		last = e
	}
	return nil, last
}
func (g *gateway) proxy(w http.ResponseWriter, r *http.Request) {
	s := g.state.Load()
	if s == nil || time.Since(s.At) >= 30*time.Second {
		fail(w, 503, "policy_unavailable")
		return
	}
	raw, ok := strings.CutPrefix(r.Header.Get("Proxy-Authorization"), "Basic ")
	decoded, e := base64.StdEncoding.DecodeString(raw)
	_, token, found := strings.Cut(string(decoded), ":")
	space := s.Tokens[digest(token)]
	if !ok || e != nil || !found || space == "" {
		w.Header().Set("Proxy-Authenticate", `Basic realm="guanyin"`)
		fail(w, 407, "invalid_space_token")
		return
	}
	scheme, authority := "http", r.URL.Host
	if r.Method == "CONNECT" {
		scheme = "https"
		authority = r.Host
	} else if r.URL.Scheme != "http" || !r.URL.IsAbs() || r.URL.User != nil || r.Host != r.URL.Host {
		fail(w, 400, "absolute_http_url_required")
		return
	}
	want, addr, e := origin(scheme, authority)
	if e != nil {
		fail(w, 400, "invalid_destination")
		return
	}
	httpAllowed := false
	if r.Method == "CONNECT" {
		httpOrigin, _, err := origin("http", authority)
		httpAllowed = err == nil && permittedOrigin(s, space, httpOrigin)
	}
	if !permittedOrigin(s, space, want) && !httpAllowed {
		fail(w, 403, "origin_not_allowed")
		return
	}
	if !g.acquire("proxy/"+space, policy{Concurrency: 8, RPM: 120}) {
		fail(w, 429, "proxy_limit_exceeded")
		return
	}
	defer g.release("proxy/" + space)
	ctx, cancel := context.WithTimeout(r.Context(), 120*time.Second)
	defer cancel()
	r = r.WithContext(ctx)
	if r.Method != "CONNECT" {
		if r.Header.Get("Upgrade") != "" {
			fail(w, 403, "http_upgrade_not_supported")
			return
		}
		tr := &http.Transport{Proxy: nil, DisableKeepAlives: true, DialContext: func(ctx context.Context, network, target string) (net.Conn, error) { return proxyDial(ctx, addr) }, ResponseHeaderTimeout: 30 * time.Second}
		defer tr.CloseIdleConnections()
		p := httputil.ReverseProxy{Rewrite: func(pr *httputil.ProxyRequest) {
			pr.Out.URL.Scheme = "http"
			pr.Out.URL.Host = authority
			pr.Out.Host = authority
			pr.Out.Header.Del("Proxy-Authorization")
			pr.Out.Header.Del("Proxy-Connection")
			pr.Out.Header.Del("Forwarded")
			pr.Out.Header.Del("X-Forwarded-For")
			pr.Out.Header.Del("X-Forwarded-Host")
			pr.Out.Header.Del("X-Forwarded-Proto")
		}, Transport: tr, FlushInterval: -1, ErrorHandler: func(w http.ResponseWriter, r *http.Request, e error) { fail(w, 502, "upstream_unavailable") }}
		p.ServeHTTP(w, r)
		return
	}
	upstream, e := proxyDial(ctx, addr)
	if e != nil {
		fail(w, 502, "connect_failed")
		return
	}
	defer upstream.Close()
	hj, ok := w.(http.Hijacker)
	if !ok {
		fail(w, 500, "hijack_unavailable")
		return
	}
	client, rw, e := hj.Hijack()
	if e != nil {
		return
	}
	defer client.Close()
	deadline := time.Now().Add(120 * time.Second)
	_ = client.SetDeadline(deadline)
	_ = upstream.SetDeadline(deadline)
	_, _ = rw.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n")
	if rw.Flush() != nil {
		return
	}
	// HTTPS grants cannot be reused as arbitrary cleartext TCP tunnels.
	first, e := rw.Peek(3)
	if e != nil {
		return
	}
	if first[0] != 0x16 || first[1] != 0x03 {
		if !httpAllowed {
			return
		}
		// Node/Undici tunnels HTTP too. Parse every request and pin its Host;
		// never turn an HTTP grant into a general-purpose raw TCP tunnel.
		upstreamReader := bufio.NewReader(upstream)
		for {
			req, err := http.ReadRequest(rw.Reader)
			if err != nil {
				return
			}
			got, _, err := origin("http", req.Host)
			expected, _, _ := origin("http", authority)
			if err != nil || got != expected || req.Method == "CONNECT" || req.Header.Get("Upgrade") != "" || req.Header.Get("Expect") != "" || req.ContentLength > 16<<20 {
				req.Body.Close()
				return
			}
			req.Body = http.MaxBytesReader(nil, req.Body, 16<<20)
			req.URL.Scheme = ""
			req.URL.Host = ""
			req.RequestURI = ""
			req.Host = authority
			req.Header.Del("Proxy-Authorization")
			req.Header.Del("Proxy-Connection")
			req.Header.Del("Forwarded")
			req.Header.Del("X-Forwarded-For")
			if err = req.Write(upstream); err != nil {
				req.Body.Close()
				return
			}
			req.Body.Close()
			resp, err := http.ReadResponse(upstreamReader, req)
			if err != nil {
				return
			}
			err = resp.Write(rw)
			resp.Body.Close()
			if err != nil {
				return
			}
			if rw.Flush() != nil {
				return
			}
			if resp.Close || req.Close {
				return
			}
		}
	}
	if !permittedOrigin(s, space, want) {
		return
	}
	done := make(chan struct{})
	go func() {
		_, _ = io.Copy(upstream, rw)
		if c, ok := upstream.(*net.TCPConn); ok {
			_ = c.CloseWrite()
		}
		close(done)
	}()
	_, _ = io.Copy(client, upstream)
	_ = client.Close()
	<-done
}
