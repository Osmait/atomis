// A REST API for a todo list, on gin.
// Open the HTTP view (terminal ⋮ → HTTP), turn on "Run as a server", and
// call the endpoints it lists: GET /todos, POST /todos {"title": "…"},
// GET /todos/1, PATCH /todos/1 {"done": true}, DELETE /todos/1.
// The data lives in memory: an edit restarts the server, and it with it.
package main

import (
	"fmt"
	"net"
	"net/http"
	"os"
	"strconv"
	"sync"

	"github.com/gin-gonic/gin"
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

var notFound = gin.H{"error": "not found"}

// find returns the index of the todo the path names, or -1 after answering 404.
// The caller holds mu.
func find(c *gin.Context) int {
	id, err := strconv.Atoi(c.Param("id"))
	if err == nil {
		for i, todo := range todos {
			if todo.ID == id {
				return i
			}
		}
	}
	c.JSON(http.StatusNotFound, notFound)
	return -1
}

func main() {
	gin.SetMode(gin.ReleaseMode)
	router := gin.New()
	router.Use(gin.Logger(), gin.Recovery())

	router.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})

	router.GET("/todos", func(c *gin.Context) {
		mu.Lock()
		defer mu.Unlock()
		list := make([]*Todo, len(todos)) // [] rather than null when empty
		copy(list, todos)
		c.JSON(http.StatusOK, list)
	})

	router.POST("/todos", func(c *gin.Context) {
		var body struct {
			Title *string `json:"title"`
		}
		// Invalid JSON, a non-object or a non-string title all fail to bind.
		if c.ShouldBindJSON(&body) != nil || body.Title == nil || *body.Title == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "title is required"})
			return
		}
		mu.Lock()
		defer mu.Unlock()
		todo := &Todo{ID: nextID, Title: *body.Title}
		todos = append(todos, todo)
		nextID++
		c.JSON(http.StatusCreated, todo)
	})

	router.GET("/todos/:id", func(c *gin.Context) {
		mu.Lock()
		defer mu.Unlock()
		if i := find(c); i >= 0 {
			c.JSON(http.StatusOK, todos[i])
		}
	})

	router.PATCH("/todos/:id", func(c *gin.Context) {
		mu.Lock()
		defer mu.Unlock()
		i := find(c)
		if i < 0 {
			return
		}
		var body struct {
			Done *bool `json:"done"`
		}
		if c.ShouldBindJSON(&body) == nil && body.Done != nil {
			todos[i].Done = *body.Done
		}
		c.JSON(http.StatusOK, todos[i])
	})

	router.DELETE("/todos/:id", func(c *gin.Context) {
		mu.Lock()
		defer mu.Unlock()
		if i := find(c); i >= 0 {
			todos = append(todos[:i], todos[i+1:]...)
			c.Status(http.StatusNoContent)
		}
	})

	// Anything else: a JSON 404 rather than gin's plain-text one.
	router.NoRoute(func(c *gin.Context) {
		c.JSON(http.StatusNotFound, notFound)
	})

	host := os.Getenv("HOST")
	if host == "" {
		host = "127.0.0.1"
	}
	port := os.Getenv("PORT")
	fmt.Println("listening on", port)
	if err := router.Run(net.JoinHostPort(host, port)); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
