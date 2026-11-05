#include <iostream>

int main() {
  long long a = 0;
  long long b = 0;
  if (!(std::cin >> a >> b)) return 1;
  std::cout << a + b << '\n';
  return 0;
}
