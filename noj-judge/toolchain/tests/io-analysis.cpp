// 固定生成数据的来源/回调验收，不包含正式题目数据。
#include <algorithm>
#include <iostream>
#include <locale>
#include <sstream>
#include <streambuf>
#include <vector>

struct Number { long value; };
__attribute__((noinline)) std::istream& operator>>(std::istream& stream, Number& number) {
    stream >> number.value;
    volatile long work = number.value;
    for (int i = 0; i < 16; ++i) work = (work * 3 + 7) % 100003;
    return stream;
}

struct Buffer : std::streambuf {
    char value = '7';
    __attribute__((noinline)) int_type underflow() override {
        setg(&value, &value, &value + 1);
        return traits_type::to_int_type(value);
    }
};

struct Facet : std::num_get<char> {
    __attribute__((noinline)) iter_type do_get(iter_type begin, iter_type end,
        std::ios_base&, std::ios_base::iostate& state, long& value) const override {
        value = 55;
        while (begin != end) ++begin;
        state |= std::ios_base::eofbit;
        return begin;
    }
};

// 名字、弱符号和 always_inline 都不授予 SDK 来源身份。
extern "C" __attribute__((weak, noinline)) int atoi(const char*) { return 42; }
__attribute__((always_inline)) inline long __stdinbuf_fake(long value) { return value + 1; }

int main() {
    std::ios::sync_with_stdio(false);
    std::cin.tie(nullptr);
    int n;
    std::cin >> n;
    std::vector<long> values;
    for (int i = 0; i < n; ++i) {
        Number number;
        std::cin >> number;
        values.push_back(number.value);
    }
    std::sort(values.begin(), values.end());
    long sum = 0;
    for (long value : values) sum += __stdinbuf_fake(value);
    std::istringstream strings("123 456");
    long a, b;
    strings >> a >> b;
    Buffer buffer;
    std::istream custom(&buffer);
    int c = custom.get();
    std::istringstream localized("9");
    localized.imbue(std::locale(std::locale::classic(), new Facet));
    long d;
    localized >> d;
    int (*volatile parse)(const char*) = atoi;
    std::cout << sum << ' ' << a + b << ' ' << c << ' ' << d << ' ' << parse("1");
}
