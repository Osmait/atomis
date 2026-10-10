// A tiny calculator REPL: it reads what you type, line by line.
// Press Run, then answer under the output: 2 + 3, sum, help, quit.
// Ctrl+D (end of input) quits too. Auto Run plays the Input text instead.
#include <iostream>
#include <numeric>
#include <optional>
#include <sstream>
#include <string>
#include <vector>

// The result, or why there is none.
struct Answer {
    std::optional<double> value;
    std::string error;
};

Answer evaluate(const std::string &line) {
    std::istringstream words(line);
    double a = 0, b = 0;
    std::string op, extra;
    if (!(words >> a >> op >> b) || (words >> extra))
        return {std::nullopt, "expected: <number> <op> <number>"};
    if (op == "+") return {a + b, ""};
    if (op == "-") return {a - b, ""};
    if (op == "*") return {a * b, ""};
    if (op == "/") {
        if (b == 0) return {std::nullopt, "can't divide by zero"};
        return {a / b, ""};
    }
    return {std::nullopt, "expected: <number> <op> <number>"};
}

int main() {
    std::vector<double> results;
    std::cout << "Tiny calculator. Try 2 + 3, or: help, sum, quit" << std::endl;
    std::string line;
    // std::flush: stdout is a pipe here, and the prompt has no newline.
    while (std::cout << "> " << std::flush && std::getline(std::cin, line)) {
        if (line == "quit") break;
        if (line.empty()) continue;
        if (line == "help") {
            std::cout << "<number> <op> <number>, with op one of + - * /" << std::endl;
        } else if (line == "sum") {
            double total = std::accumulate(results.begin(), results.end(), 0.0);
            std::cout << "total of " << results.size() << " results: " << total << std::endl;
        } else {
            Answer answer = evaluate(line);
            if (answer.value) {
                results.push_back(*answer.value);
                std::cout << *answer.value << std::endl;
            } else {
                std::cout << "? " << answer.error << std::endl;
            }
        }
    }
    std::cout << "bye" << std::endl;
    return 0;
}
