package main

import (
	"fmt"
	"os"
)

const defaultModel = "gpt-fixture-retired"

var prompt = `Answer briefly.
Model: claude-fixture-opus-9
`

type Request struct {
	Model string `json:"model"`
}

func main() {
	req := Request{Model: os.Getenv("MODEL")}
	other := Request{Model: defaultModel}
	r := 'x'
	// "gpt-fixture-3" in a comment
	fmt.Println(req, other, r, "gemini-fixture-1.0-flash")
}
