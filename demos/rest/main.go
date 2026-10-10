// A REST API for a todo list, on net/http alone (Go 1.22 route patterns).
// Open the HTTP view (terminal ⋮ → HTTP), turn on "Run as a server", and
// call the endpoints it lists: GET /todos, POST /todos {"title": "…"},
// GET /todos/1, PATCH /todos/1 {"done": true}, DELETE /todos/1.
// The data lives in memory: an edit restarts the server, and it with it.
package main

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"strconv"
	"sync"
)

type Todo struct {
	ID    int    `json:"id"`
	Title string `json:"title"`
	Done  bool   `json:"done"`
}

var (
	mu     sync.Mutex
	todos  []*Todo // in creation order
	nextID = 1
)

func reply(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(payload)
}

// find returns the index of the todo the path names, or -1 after answering 404.
// The caller holds mu.
func find(w http.ResponseWriter, r *http.Request) int {
	id, err := strconv.Atoi(r.PathValue("id"))
	if err == nil {
		for i, todo := range todos {
			if todo.ID == id {
				return i
			}
		}
	}
	reply(w, http.StatusNotFound, map[string]string{"error": "not found"})
	return -1
}

func main() {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		reply(w, http.StatusOK, map[string]bool{"ok": true})
	})

	mux.HandleFunc("GET /todos", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		list := make([]*Todo, len(todos)) // [] rather than null when empty
		copy(list, todos)
		reply(w, http.StatusOK, list)
	})

	mux.HandleFunc("POST /todos", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Title *string `json:"title"`
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil || body.Title == nil || *body.Title == "" {
			reply(w, http.StatusBadRequest, map[string]string{"error": "title is required"})
			return
		}
		mu.Lock()
		defer mu.Unlock()
		todo := &Todo{ID: nextID, Title: *body.Title}
		todos = append(todos, todo)
		nextID++
		reply(w, http.StatusCreated, todo)
	})

	mux.HandleFunc("GET /todos/{id}", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if i := find(w, r); i >= 0 {
			reply(w, http.StatusOK, todos[i])
		}
	})

	mux.HandleFunc("PATCH /todos/{id}", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		i := find(w, r)
		if i < 0 {
			return
		}
		var body struct {
			Done *bool `json:"done"`
		}
		if json.NewDecoder(r.Body).Decode(&body) == nil && body.Done != nil {
			todos[i].Done = *body.Done
		}
		reply(w, http.StatusOK, todos[i])
	})

	mux.HandleFunc("DELETE /todos/{id}", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if i := find(w, r); i >= 0 {
			todos = append(todos[:i], todos[i+1:]...)
			w.WriteHeader(http.StatusNoContent)
		}
	})

	// Anything else: a JSON 404 rather than net/http's plain-text one.
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		reply(w, http.StatusNotFound, map[string]string{"error": "not found"})
	})

	host := os.Getenv("HOST")
	if host == "" {
		host = "127.0.0.1"
	}
	port := os.Getenv("PORT")
	fmt.Println("listening on", port)
	if err := http.ListenAndServe(net.JoinHostPort(host, port), mux); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
