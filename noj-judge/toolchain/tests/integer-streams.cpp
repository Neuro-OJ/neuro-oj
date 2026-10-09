// NOJ 标准库回归：覆盖整数边界、locale、EOF 和迭代器语义。
#include <cassert>
#include <cstdint>
#include <iomanip>
#include <iostream>
#include <limits>
#include <locale>
#include <sstream>
#include <string>

template <class T>
void check(const char* text, T expected, bool failure = false) {
  std::istringstream input(text);
  T value = 17;
  input >> value;
  assert(value == expected);
  assert(input.fail() == failure);
  assert(!input.bad());
}

struct grouped : std::numpunct<char> {
  char do_thousands_sep() const override { return '_'; }
  std::string do_grouping() const override { return "\3"; }
};

struct wide_digits : std::ctype<wchar_t> {
  wchar_t do_widen(char c) const override {
    return c >= '0' && c <= '9' ? L'０' + c - '0' : wchar_t(c);
  }
  const char* do_widen(const char* first, const char* last, wchar_t* out) const override {
    while (first != last) *out++ = do_widen(*first++);
    return last;
  }
};

struct character_numbers : std::num_get<char, const char*> {
  character_numbers() : std::num_get<char, const char*>(1) {}
  ~character_numbers() {}
};

int main() {
  check<long long>("0", 0);
  check<long long>("-0", 0);
  check<long long>("  +123\t", 123);
  check<long long>("-9223372036854775808", std::numeric_limits<long long>::min());
  check<long long>("9223372036854775807", std::numeric_limits<long long>::max());
  check<long long>("9223372036854775808", std::numeric_limits<long long>::max(), true);
  check<long long>("-9223372036854775809", std::numeric_limits<long long>::min(), true);
  check<unsigned long long>("18446744073709551615", std::numeric_limits<unsigned long long>::max());
  check<unsigned long long>("18446744073709551616", std::numeric_limits<unsigned long long>::max(), true);
  check<unsigned long long>("-1", std::numeric_limits<unsigned long long>::max());
  check<short>("32767", 32767);
  check<short>("32768", std::numeric_limits<short>::max(), true);
  check<int>("2147483648", std::numeric_limits<int>::max(), true);
  check<long long>("x", 0, true);
  check<long long>("+", 0, true);
  check<long long>("-", 0, true);
  check<long long>("", 17, true);
  check<long long>("   ", 17, true);

  for (long long n = -2000; n <= 2000; ++n) {
    std::string text = std::to_string(n);
    check<long long>(text.c_str(), n);
  }
  std::istringstream bases("0xFF 077 42 Ff");
  long long a, b, c, d;
  bases >> std::setbase(0) >> a >> b >> c >> std::hex >> d;
  assert(a == 255 && b == 63 && c == 42 && d == 255 && !bases.fail());
  std::istringstream hex_limit("ffffffffffffffff");
  unsigned long long u;
  hex_limit >> std::hex >> u;
  assert(u == std::numeric_limits<unsigned long long>::max() && !hex_limit.fail());

  std::locale grouping(std::locale::classic(), new grouped);
  std::istringstream valid("1_234 -12_345");
  valid.imbue(grouping);
  valid >> a >> b;
  assert(a == 1234 && b == -12345 && !valid.fail());
  std::istringstream invalid("1_23");
  invalid.imbue(grouping);
  invalid >> a;
  assert(invalid.fail());
  std::wistringstream wide(L"１２３");
  wide.imbue(std::locale(std::locale::classic(), new wide_digits));
  wide >> a;
  assert(a == 123 && !wide.fail());

  std::istringstream tail("12x");
  tail >> a;
  assert(a == 12 && !tail.fail() && tail.peek() == 'x');
  assert(tail.get() == 'x');
  tail.unget();
  assert(tail.peek() == 'x');
  std::istringstream ended("42");
  ended >> a;
  assert(a == 42 && ended.eof() && !ended.fail());
  ended >> b;
  assert(ended.fail());
  character_numbers facet;
  const char data[] = "123x";
  std::ios_base::iostate error = std::ios_base::goodbit;
  auto stop = facet.get(data, data + 4, tail, error, a);
  assert(a == 123 && stop == data + 3 && error == std::ios_base::goodbit);
  std::cout << 42;
}
