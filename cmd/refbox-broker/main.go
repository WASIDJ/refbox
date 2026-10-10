package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/WASIDJ/refbox/internal/broker"
)

func env(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func main() {
	address := env("REFBOX_BROKER_LISTEN", "127.0.0.1:18814")
	if err := broker.ListenAddress(address); err != nil {
		log.Fatal(err)
	}
	services, err := broker.ServicesFromJSON(os.Getenv("REFBOX_BROKER_SERVICES"))
	if err != nil {
		log.Fatal(err)
	}
	store, err := broker.OpenStore(env("REFBOX_BROKER_DATABASE", "var/broker.sqlite"))
	if err != nil {
		log.Fatal("broker receipt database is unavailable")
	}
	defer store.Close()
	app, err := broker.New(store, broker.Config{Token: os.Getenv("REFBOX_BROKER_TOKEN"), Services: services})
	if err != nil {
		log.Fatal(err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	server := &http.Server{Addr: address, Handler: app, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 30 * time.Second}
	stopped := make(chan struct{})
	go func() {
		<-ctx.Done()
		deadline, cancel := context.WithTimeout(context.Background(), 21*time.Second)
		defer cancel()
		_ = server.Shutdown(deadline)
		close(stopped)
	}()
	log.Printf("refbox action broker: %s", address)
	if err = server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
	<-stopped
}
