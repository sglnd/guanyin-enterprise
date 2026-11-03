package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"

	"testing"
	"time"
)

func TestOriginRules(t *testing.T) {
	for _, v := range []struct{ s, h, w string }{{"http", "Internal.EXAMPLE:8080", "http://internal.example:8080"}, {"https", "example.com", "https://example.com:443"}, {"http", "[fd00::1]:3000", "http://[fd00::1]:3000"}} {
		o, _, e := origin(v.s, v.h)
		if e != nil || o != v.w {
			t.Fatal(o, e)
		}
	}
	s := &snapshot{Origins: map[string][]string{"a": {"http://internal.example:8080"}}}
	for _, bad := range []struct{ space, url string }{{"a", "https://internal.example:8080"}, {"a", "http://internal.example:80"}, {"b", "http://internal.example:8080"}} {
		if permittedOrigin(s, bad.space, bad.url) {
			t.Fatal(bad)
		}
	}
}
func TestProxyPrivateHTTPAndTLS(t *testing.T) {
	// Bind a private interface, so test the actual private-address path, not a loopback exception.
	var ip string
	addrs, _ := net.InterfaceAddrs()
	for _, a := range addrs {
		if n, ok := a.(*net.IPNet); ok && n.IP.To4() != nil && n.IP.IsPrivate() {
			ip = n.IP.String()
			break
		}
	}
	if ip == "" {
		t.Skip("no private interface")
	}
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Proxy-Authorization") != "" {
			t.Error("proxy credential leaked")
		}
		io.WriteString(w, "proxy-ok")
	})
	plain := httptest.NewUnstartedServer(handler)
	ln, e := net.Listen("tcp", net.JoinHostPort(ip, "0"))
	if e != nil {
		t.Fatal(e)
	}
	plain.Listener = ln
	plain.Start()
	defer plain.Close()
	tls := httptest.NewUnstartedServer(handler)
	ln, e = net.Listen("tcp", net.JoinHostPort(ip, "0"))
	if e != nil {
		t.Fatal(e)
	}
	tls.Listener = ln
	tls.StartTLS()
	defer tls.Close()
	g, _ := fixture(t)
	s := g.state.Load()
	s.Origins = map[string][]string{"space-a": {plain.URL, tls.URL}}
	s.At = time.Now()
	g.state.Store(s)
	proxy := httptest.NewServer(http.HandlerFunc(g.proxy))
	defer proxy.Close()
	pu, _ := url.Parse(proxy.URL)
	pu.User = url.UserPassword("space", "a")
	tlsConfig := tls.Client().Transport.(*http.Transport).TLSClientConfig.Clone()
	tlsConfig.ServerName = "127.0.0.1"
	tr := &http.Transport{Proxy: http.ProxyURL(pu), TLSClientConfig: tlsConfig}
	defer tr.CloseIdleConnections()
	c := &http.Client{Transport: tr, Timeout: 5 * time.Second}
	for _, u := range []string{plain.URL, tls.URL} {
		r, e := c.Get(u)
		if e != nil {
			t.Fatal(e)
		}
		b, _ := io.ReadAll(r.Body)
		r.Body.Close()
		if r.StatusCode != 200 || string(b) != "proxy-ok" {
			t.Fatal(r.StatusCode, string(b))
		}
	}
	pu.User = url.UserPassword("space", "b")
	r, e := c.Get(plain.URL)
	if e != nil {
		t.Fatal(e)
	}
	r.Body.Close()
	if r.StatusCode != 403 {
		t.Fatal("cross space", r.StatusCode)
	}
	if c, e := proxyDial(context.Background(), "127.0.0.1:80"); e == nil {
		c.Close()
		t.Fatal("loopback allowed")
	}

}

func TestHTTPConnectTunnelIsParsedAndHostPinned(t *testing.T) {
	var ip string
	addrs, _ := net.InterfaceAddrs()
	for _, a := range addrs {
		if n, ok := a.(*net.IPNet); ok && n.IP.To4() != nil && n.IP.IsPrivate() {
			ip = n.IP.String()
			break
		}
	}
	if ip == "" {
		t.Skip("no private interface")
	}
	hits := 0
	up := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		if r.Header.Get("Proxy-Authorization") != "" {
			t.Error("proxy credential leaked")
		}
		io.WriteString(w, "tunnel-ok")
	}))
	ln, e := net.Listen("tcp", net.JoinHostPort(ip, "0"))
	if e != nil {
		t.Fatal(e)
	}
	up.Listener = ln
	up.Start()
	defer up.Close()
	g, _ := fixture(t)
	s := g.state.Load()
	s.Origins = map[string][]string{"space-a": {up.URL}}
	g.state.Store(s)
	proxy := httptest.NewServer(http.HandlerFunc(g.proxy))
	defer proxy.Close()
	pu, _ := url.Parse(proxy.URL)
	target, _ := url.Parse(up.URL)
	conn, e := net.Dial("tcp", pu.Host)
	if e != nil {
		t.Fatal(e)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(3 * time.Second))
	fmt.Fprintf(conn, "CONNECT %s HTTP/1.1\r\nHost: %s\r\nProxy-Authorization: Basic c3BhY2U6YQ==\r\n\r\n", target.Host, target.Host)
	br := bufio.NewReader(conn)
	res, e := http.ReadResponse(br, &http.Request{Method: "CONNECT"})
	if e != nil || res.StatusCode != 200 {
		t.Fatal(e)
	}
	fmt.Fprintf(conn, "GET / HTTP/1.1\r\nHost: %s\r\n\r\n", target.Host)
	res, e = http.ReadResponse(br, &http.Request{Method: "GET"})
	if e != nil {
		t.Fatal(e)
	}
	data, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if string(data) != "tunnel-ok" {
		t.Fatal(string(data))
	}
	fmt.Fprint(conn, "GET / HTTP/1.1\r\nHost: forbidden.example:80\r\n\r\n")
	_, e = http.ReadResponse(br, &http.Request{Method: "GET"})
	if e == nil {
		t.Fatal("cross-host request accepted")
	}
	if hits != 1 {
		t.Fatal(hits)
	}
}
