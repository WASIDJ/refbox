package main

import (
	"context"
	"github.com/WASIDJ/refbox/internal/control"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func env(key, value string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return value
}
func main() {
	app, err := control.New(control.Config{EngineURL: env("REFBOX_ENGINE_URL", "http://127.0.0.1:8801"), EngineToken: os.Getenv("REFBOX_ENGINE_TOKEN"), PasswordHash: os.Getenv("REFBOX_PASSWORD_HASH"), WebDir: env("REFBOX_WEB_DIR", "apps/web/dist"), SecureCookie: os.Getenv("REFBOX_SECURE_COOKIE") == "true"})
	if err != nil {
		log.Fatal("配置无效：", err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go app.ReportLoop(ctx)
	server := &http.Server{Addr: env("REFBOX_LISTEN", "127.0.0.1:8080"), Handler: app, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 90 * time.Second}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	log.Print("refbox 控制台：", server.Addr)
	if err = server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
