package main

import "os"

func main() {
	_ = Request{Model: os.Getenv("MODEL")}
	_ = Request{Model: cfg.Model}
}
