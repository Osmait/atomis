// A tiny calculator REPL: it reads what you type, line by line.
// Press Run, then answer under the output: 2 + 3, sum, help, quit.
// Ctrl+D (end of input) quits too. Auto Run plays the Input text instead.
package main

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
)

func evaluate(line string) (float64, error) {
	parts := strings.Fields(line)
	if len(parts) != 3 {
		return 0, errors.New("expected: <number> <op> <number>")
	}
	a, errA := strconv.ParseFloat(parts[0], 64)
	b, errB := strconv.ParseFloat(parts[2], 64)
	if errA != nil || errB != nil {
		return 0, errors.New("not a number")
	}
	switch parts[1] {
	case "+":
		return a + b, nil
	case "-":
		return a - b, nil
	case "*":
		return a * b, nil
	case "/":
		if b == 0 {
			return 0, errors.New("can't divide by zero")
		}
		return a / b, nil
	}
	return 0, errors.New("expected: <number> <op> <number>")
}

func main() {
	var results []float64
	fmt.Println("Tiny calculator. Try 2 + 3, or: help, sum, quit")
	scanner := bufio.NewScanner(os.Stdin)
	for {
		fmt.Print("> ")
		if !scanner.Scan() {
			break
		}
		line := strings.TrimSpace(scanner.Text())
		if line == "quit" {
			break
		}
		switch line {
		case "":
		case "help":
			fmt.Println("<number> <op> <number>, with op one of + - * /")
		case "sum":
			total := 0.0
			for _, result := range results {
				total += result
			}
			fmt.Printf("total of %d results: %v\n", len(results), total)
		default:
			result, err := evaluate(line)
			if err != nil {
				fmt.Println("?", err)
				continue
			}
			results = append(results, result)
			fmt.Println(result)
		}
	}
	fmt.Println("bye")
}
