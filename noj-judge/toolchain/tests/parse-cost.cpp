// 固定成本对照：cin、带边界检查的 getchar 解析，以及批量读取。
#include <cstdio>
#include <iostream>
#include <limits>

static char buffer[65536];
static unsigned position = 0, length = 0;
static bool bulk = false;

int next_character() {
  if (!bulk) return std::getchar();
  if (position == length) {
    length = std::fread(buffer, 1, sizeof buffer, stdin);
    position = 0;
    if (!length) return EOF;
  }
  return static_cast<unsigned char>(buffer[position++]);
}

bool read_integer(long long& result) {
  int c = next_character();
  while (c != EOF && c <= ' ') c = next_character();
  if (c == EOF) return false;
  bool negative = c == '-';
  if (c == '-' || c == '+') c = next_character();
  if (c < '0' || c > '9') return false;
  unsigned long long value = 0;
  const unsigned long long limit = static_cast<unsigned long long>(std::numeric_limits<long long>::max()) + negative;
  const auto cutoff = limit / 10, remainder = limit % 10;
  bool overflow = false;
  do {
    unsigned digit = c - '0';
    if (value > cutoff || (value == cutoff && digit > remainder)) overflow = true;
    if (!overflow) value = value * 10 + digit;
    c = next_character();
  } while (c >= '0' && c <= '9');
  if (overflow) return false;
  result = negative ? (value == limit ? std::numeric_limits<long long>::min() : -static_cast<long long>(value))
                    : static_cast<long long>(value);
  return true;
}

int main() {
  std::ios::sync_with_stdio(false);
  std::cin.tie(nullptr);
  int mode = std::getchar();
  long long value = 0, sum = 0;
  if (mode == 'C') {
    while (std::cin >> value) sum += value;
  } else {
    bulk = mode == 'B';
    while (read_integer(value)) sum += value;
  }
  std::cout << sum;
}
