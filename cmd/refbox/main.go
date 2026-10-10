package main

import (
	"context"
	"encoding/json"
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
	var plugins []control.PluginRegistration
	if err := json.Unmarshal([]byte(env("REFBOX_PLUGIN_MANIFESTS", "[]")), &plugins); err != nil {
		log.Fatal("插件清单配置无效")
	}
	app, err := control.New(control.Config{EngineURL: env("REFBOX_ENGINE_URL", "http://127.0.0.1:18801"), EngineToken: os.Getenv("REFBOX_ENGINE_TOKEN"), PasswordHash: os.Getenv("REFBOX_PASSWORD_HASH"), WebDir: env("REFBOX_WEB_DIR", "apps/web/dist"), SecureCookie: os.Getenv("REFBOX_SECURE_COOKIE") == "true", PlatformDatabase: env("REFBOX_PLATFORM_DATABASE", "var/platform.sqlite"), PlatformToken: os.Getenv("REFBOX_PLATFORM_TOKEN"), BrokerURL: env("REFBOX_BROKER_URL", "http://127.0.0.1:18814"), BrokerToken: os.Getenv("REFBOX_BROKER_TOKEN"), VerifierURL: env("REFBOX_VERIFIER_URL", "http://127.0.0.1:18812"), VerifierToken: os.Getenv("REFBOX_VERIFIER_TOKEN"), AutoRepair: os.Getenv("REFBOX_AUTO_REPAIR") == "true", BuiltinPlugins: plugins})
	if err != nil {
		log.Fatal("配置无效：", err)
	}
	defer app.Close()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go app.ReportLoop(ctx)
	go app.PlatformLoop(ctx)
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
