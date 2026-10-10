// A mini Redis: an in-memory key-value store that logs every write to a
// file, and replays (then compacts) that log the next time it starts.
// Press Run and type commands under the output: SET name Ada, GET name,
// INCR visits, DEL name, EXISTS name, KEYS, DBSIZE, FLUSHALL, QUIT.
// Run it again: the data is still there. Auto Run replays the Input text.
package main

import (
	"bufio"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
)

const logPath = "../redis.aof" // beside src/, so it is not one of your project files

var commands = map[string]bool{
	"SET": true, "GET": true, "DEL": true, "EXISTS": true,
	"INCR": true, "KEYS": true, "DBSIZE": true, "FLUSHALL": true,
}

// replay rebuilds the store from the log: the cache starts as the file left it.
func replay(path string) (map[string]string, int) {
	store := map[string]string{}
	entries := 0
	data, err := os.ReadFile(path)
	if err != nil {
		return store, 0
	}
	for _, line := range strings.Split(strings.TrimSuffix(string(data), "\n"), "\n") {
		if line == "" {
			continue
		}
		entries++
		op, rest, _ := strings.Cut(line, " ")
		switch op {
		case "SET":
			key, value, _ := strings.Cut(rest, " ")
			store[key] = value
		case "DEL":
			delete(store, rest)
		case "FLUSHALL":
			store = map[string]string{}
		}
	}
	return store, entries
}

func sortedKeys(store map[string]string) []string {
	keys := make([]string, 0, len(store))
	for key := range store {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

type db struct {
	store map[string]string
	log   *os.File
}

func (d *db) append(entry string) {
	if _, err := fmt.Fprintln(d.log, entry); err != nil {
		panic(err)
	}
}

func (d *db) execute(words []string) string {
	command, args := strings.ToUpper(words[0]), words[1:]
	switch {
	case command == "SET" && len(args) >= 2:
		value := strings.Join(args[1:], " ")
		d.store[args[0]] = value
		d.append("SET " + args[0] + " " + value)
		return "OK"
	case command == "GET" && len(args) == 1:
		if value, ok := d.store[args[0]]; ok {
			return `"` + value + `"`
		}
		return "(nil)"
	case command == "DEL" && len(args) == 1:
		if _, ok := d.store[args[0]]; !ok {
			return "(integer) 0"
		}
		delete(d.store, args[0])
		d.append("DEL " + args[0])
		return "(integer) 1"
	case command == "EXISTS" && len(args) == 1:
		if _, ok := d.store[args[0]]; ok {
			return "(integer) 1"
		}
		return "(integer) 0"
	case command == "INCR" && len(args) == 1:
		current, ok := d.store[args[0]]
		if !ok {
			current = "0"
		}
		number, err := strconv.ParseInt(current, 10, 64)
		if err != nil || number == 1<<63-1 {
			return "(error) ERR value is not an integer or out of range"
		}
		number++
		d.store[args[0]] = strconv.FormatInt(number, 10)
		d.append(fmt.Sprintf("SET %s %d", args[0], number))
		return fmt.Sprintf("(integer) %d", number)
	case command == "KEYS" && len(args) <= 1:
		keys := sortedKeys(d.store)
		if len(keys) == 0 {
			return "(empty array)"
		}
		lines := make([]string, len(keys))
		for i, key := range keys {
			lines[i] = fmt.Sprintf("%d) \"%s\"", i+1, key)
		}
		return strings.Join(lines, "\n")
	case command == "DBSIZE" && len(args) == 0:
		return fmt.Sprintf("(integer) %d", len(d.store))
	case command == "FLUSHALL" && len(args) == 0:
		d.store = map[string]string{}
		d.append("FLUSHALL")
		return "OK"
	case commands[command]:
		return fmt.Sprintf("(error) ERR wrong number of arguments for '%s'", strings.ToLower(words[0]))
	}
	return fmt.Sprintf("(error) ERR unknown command '%s'", words[0])
}

func main() {
	store, entries := replay(logPath)
	fmt.Printf("loaded %d keys (%d log entries) from redis.aof\n", len(store), entries)
	// Compaction: the log restarts as one SET per key, then grows a line per write.
	log, err := os.Create(logPath)
	if err != nil {
		panic(err)
	}
	defer log.Close()
	d := &db{store: store, log: log}
	for _, key := range sortedKeys(store) {
		d.append("SET " + key + " " + store[key])
	}

	fmt.Println("mini-redis ready: SET GET DEL EXISTS INCR KEYS DBSIZE FLUSHALL QUIT")
	scanner := bufio.NewScanner(os.Stdin)
	for {
		fmt.Print("redis> ")
		if !scanner.Scan() {
			break
		}
		words := strings.Fields(scanner.Text())
		if len(words) == 0 {
			continue
		}
		if strings.ToUpper(words[0]) == "QUIT" {
			break
		}
		fmt.Println(d.execute(words))
	}
	fmt.Println("bye")
}
