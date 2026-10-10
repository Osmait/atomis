// A mini Redis: an in-memory key-value store that logs every write to a
// file, and replays (then compacts) that log the next time it starts.
// Press Run and type commands under the output: SET name Ada, GET name,
// INCR visits, DEL name, EXISTS name, KEYS, DBSIZE, FLUSHALL, QUIT.
// Run it again: the data is still there. Auto Run replays the Input text.
#include <algorithm>
#include <cctype>
#include <fstream>
#include <iostream>
#include <limits>
#include <map>
#include <set>
#include <sstream>
#include <string>
#include <vector>

const std::string LOG = "../redis.aof"; // beside src/, so it is not one of your project files
const std::set<std::string> COMMANDS = {"SET", "GET", "DEL", "EXISTS", "INCR", "KEYS", "DBSIZE", "FLUSHALL"};

std::string transform(std::string text, int (*change)(int)) {
    std::transform(text.begin(), text.end(), text.begin(),
                   [change](unsigned char c) { return static_cast<char>(change(c)); });
    return text;
}

// A std::map keeps its keys sorted: KEYS and compaction need that order.
using Store = std::map<std::string, std::string>;

// Rebuilds the store from the log: the cache starts as the file left it.
int replay(const std::string &path, Store &store) {
    std::ifstream file(path);
    std::string line;
    int entries = 0;
    while (std::getline(file, line)) {
        entries++;
        auto space = line.find(' ');
        std::string op = line.substr(0, space);
        std::string rest = space == std::string::npos ? "" : line.substr(space + 1);
        if (op == "SET") {
            auto gap = rest.find(' ');
            store[rest.substr(0, gap)] = gap == std::string::npos ? "" : rest.substr(gap + 1);
        } else if (op == "DEL") {
            store.erase(rest);
        } else if (op == "FLUSHALL") {
            store.clear();
        }
    }
    return entries;
}

struct Db {
    Store store;
    std::ofstream log;

    void append(const std::string &entry) { log << entry << std::endl; }

    std::string execute(const std::vector<std::string> &words) {
        std::string command = transform(words[0], ::toupper);
        std::vector<std::string> args(words.begin() + 1, words.end());
        if (command == "SET" && args.size() >= 2) {
            std::string value = args[1];
            for (size_t i = 2; i < args.size(); i++) value += " " + args[i];
            store[args[0]] = value;
            append("SET " + args[0] + " " + value);
            return "OK";
        }
        if (command == "GET" && args.size() == 1) {
            auto found = store.find(args[0]);
            return found == store.end() ? "(nil)" : "\"" + found->second + "\"";
        }
        if (command == "DEL" && args.size() == 1) {
            if (store.erase(args[0]) == 0) return "(integer) 0";
            append("DEL " + args[0]);
            return "(integer) 1";
        }
        if (command == "EXISTS" && args.size() == 1) {
            return "(integer) " + std::to_string(store.count(args[0]));
        }
        if (command == "INCR" && args.size() == 1) {
            auto found = store.find(args[0]);
            std::string current = found == store.end() ? "0" : found->second;
            long long number = 0;
            size_t used = 0;
            try {
                number = std::stoll(current, &used);
            } catch (...) {
                used = 0;
            }
            if (used == 0 || used != current.size() || std::isspace(static_cast<unsigned char>(current[0])) ||
                number == std::numeric_limits<long long>::max()) {
                return "(error) ERR value is not an integer or out of range";
            }
            store[args[0]] = std::to_string(number + 1);
            append("SET " + args[0] + " " + std::to_string(number + 1));
            return "(integer) " + std::to_string(number + 1);
        }
        if (command == "KEYS" && args.size() <= 1) {
            if (store.empty()) return "(empty array)";
            std::ostringstream keys;
            int i = 0;
            for (const auto &[key, value] : store) keys << (i ? "\n" : "") << ++i << ") \"" << key << "\"";
            return keys.str();
        }
        if (command == "DBSIZE" && args.empty()) return "(integer) " + std::to_string(store.size());
        if (command == "FLUSHALL" && args.empty()) {
            store.clear();
            append("FLUSHALL");
            return "OK";
        }
        if (COMMANDS.count(command)) {
            return "(error) ERR wrong number of arguments for '" + transform(words[0], ::tolower) + "'";
        }
        return "(error) ERR unknown command '" + words[0] + "'";
    }
};

int main() {
    Db db;
    int entries = replay(LOG, db.store);
    std::cout << "loaded " << db.store.size() << " keys (" << entries << " log entries) from redis.aof" << std::endl;
    // Compaction: the log restarts as one SET per key, then grows a line per write.
    db.log.open(LOG, std::ios::trunc);
    for (const auto &[key, value] : db.store) db.log << "SET " << key << " " << value << "\n";
    db.log.flush();

    std::cout << "mini-redis ready: SET GET DEL EXISTS INCR KEYS DBSIZE FLUSHALL QUIT" << std::endl;
    std::string line;
    // std::flush: stdout is a pipe here, and the prompt has no newline.
    while (std::cout << "redis> " << std::flush && std::getline(std::cin, line)) {
        std::istringstream in(line);
        std::vector<std::string> words;
        for (std::string word; in >> word;) words.push_back(word);
        if (words.empty()) continue;
        if (transform(words[0], ::toupper) == "QUIT") break;
        std::cout << db.execute(words) << std::endl;
    }
    std::cout << "bye" << std::endl;
    return 0;
}
