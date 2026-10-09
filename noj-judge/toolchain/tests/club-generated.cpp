// 生成数据回归：普通 cin/cout 与三组优先队列，不包含正式题目数据。
#include <algorithm>
#include <array>
#include <functional>
#include <iostream>
#include <queue>
#include <utility>
#include <vector>

using Scores = std::array<long long, 3>;
using Entry = std::pair<long long, Scores>;
using Queue = std::priority_queue<Entry, std::vector<Entry>, std::greater<Entry>>;

long long cost(const Scores& scores, int group) {
  return scores[group] - std::max(scores[(group + 1) % 3], scores[(group + 2) % 3]);
}

int main() {
  std::ios::sync_with_stdio(false);
  std::cin.tie(nullptr);
  int tests;
  std::cin >> tests;
  while (tests--) {
    int n;
    std::cin >> n;
    std::array<Queue, 3> groups;
    for (int i = 0; i < n; ++i) {
      Scores scores;
      std::cin >> scores[0] >> scores[1] >> scores[2];
      int group = 0;
      for (int j = 1; j < 3; ++j)
        if (scores[j] > scores[group]) group = j;
      groups[group].push({cost(scores, group), scores});
    }
    for (int group = 0; group < 3; ++group) {
      while (groups[group].size() * 2 > static_cast<unsigned>(n)) {
        Scores scores = groups[group].top().second;
        groups[group].pop();
        int next = (group + 1) % 3;
        if (scores[(group + 2) % 3] > scores[next]) next = (group + 2) % 3;
        groups[next].push({cost(scores, next), scores});
      }
    }
    long long answer = 0;
    for (int group = 0; group < 3; ++group) {
      while (!groups[group].empty()) {
        answer += groups[group].top().second[group];
        groups[group].pop();
      }
    }
    std::cout << answer << '\n';
  }
}
