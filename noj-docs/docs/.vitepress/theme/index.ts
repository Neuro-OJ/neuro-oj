// 主题入口（结构参照 AstrBot 文档站）
import { h } from "vue";
import DefaultTheme from "vitepress/theme";
import "./styles/style.css";
import "./styles/custom-block.css";
import "./styles/font.css";
import Layout from "./components/Layout.vue";
import ArticleShare from "./components/ArticleShare.vue";
import NotFound from "./components/NotFound.vue";

export default {
  extends: DefaultTheme,
  Layout() {
    return h(Layout, null, {
      // 文档页右侧大纲下方：分享链接按钮
      "aside-outline-after": () => h(ArticleShare),
      // 404 页自定义
      "not-found": () => h(NotFound),
    });
  },
};
