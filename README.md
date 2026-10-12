# 文风 · WenFeng

把偶然读到的好文字，慢慢收成一本自己的书。

文风是一个简体中文的文字收藏工具，适配手机与电脑。可以粘贴抖音分享文字，提取其中的文案、作者标记、话题和作品链接，也可以直接摘录文章。

- **打开网页：** <https://ktclat.github.io/WenFeng/>
- **完整源码：** [`master`](https://github.com/Ktclat/WenFeng/tree/master)
- **网页发布文件：** [`gh-pages`](https://github.com/Ktclat/WenFeng/tree/gh-pages)

## GitHub Pages 版能做什么

- 在浏览器中整理抖音分享文字；结果先进入可编辑预览，确认后才保存。
- 收藏纯链接，之后补充正文；手动添加、修改标题和作者备注。
- 自定义分类、标签、全文搜索、星标、排序、卡片与列表视图。
- 移入回收站、恢复；永久删除需在界面确认。
- 导出 JSON 备份和 Markdown 文字集，导入 JSON 时预览数量、检查格式并跳过重复收藏。
- 原创示例独立展示，只有主动保存后才会进入收藏。

### 数据保存在什么地方

GitHub Pages 版使用当前浏览器的 **IndexedDB**，无需登录，不会把收藏正文上传到服务器。同一设备、同一浏览器的普通模式下，再次打开同一网址即可读取之前的收藏。

它不会自动跨设备、跨浏览器或与其他托管版本同步。清理站点数据、使用隐私模式或更换浏览器可能导致收藏丢失，建议定期使用右上角「导入 / 导出」保存 JSON 备份。备份也可以用于迁移到另一个文风实例。

### 抖音解析的范围

此静态网页只处理你粘贴的文字。分享文案可能是简介或节选，**不代表作品全文**。只有链接时，页面会保留链接并提示补充正文，不会声称已解析完整文章。

静态版不自动读取抖音远程网页、识别图中文字、下载视频、转写口播/字幕、登录抖音或同步抖音收藏夹。GitHub Pages 只能托管静态 HTML、CSS 和 JavaScript，不能在该分支上运行本项目的服务端 API。[GitHub Pages 官方说明](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)

## 本地开发与构建

需要 Node.js 22.13 或更高版本，以及 `package.json` 中指定版本的 pnpm。先安装依赖，再运行以下命令：

```sh
git clone --branch master https://github.com/Ktclat/WenFeng.git
cd WenFeng
pnpm install --frozen-lockfile

# 开发 GitHub Pages 版
pnpm dev:pages

# 生成可以直接发布的静态网页
pnpm build:pages

# 在本地预览构建结果
pnpm preview:pages
```

开发和预览页面位于命令输出的本地地址下的 `/WenFeng/`。生产构建输出在 `dist-pages/`，包含 `index.html`、`assets/`、图标、许可证和 `.nojekyll`。

`vite.pages.config.ts` 将资源基础路径固定为 `/WenFeng/`。如果改用其他仓库名或独立域名，需要相应修改 `base` 后重新构建。仅复制源文件到 `gh-pages` 无法运行，必须发布构建产物。

### 再次发布到 gh-pages

本仓库的 GitHub Pages 发布源应设置为 **Deploy from a branch → gh-pages → / (root)**。网页文件位于该分支根目录，`.nojekyll` 用来跳过 Jekyll 处理。[发布源配置说明](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)

修改源码并提交到 `master` 后，先运行 `git push origin master` 同步源码，再运行 `pnpm build:pages`。将 `dist-pages/` 的全部内容（含 `.nojekyll`）提交到 `gh-pages`。使用 Git 和 rsync 的一种方式如下；`../wenfeng-pages` 应是专用于发布的工作目录。

首次发布时创建工作目录，此段只需执行一次：

```sh
git fetch origin gh-pages
git worktree add ../wenfeng-pages gh-pages
```

每次发布时，在没有未提交修改的发布目录中执行：

```sh
git -C ../wenfeng-pages pull --ff-only origin gh-pages
rsync -a --delete --exclude='.git' dist-pages/ ../wenfeng-pages/
git -C ../wenfeng-pages add --all
git -C ../wenfeng-pages commit -m "Deploy WenFeng to GitHub Pages"
git -C ../wenfeng-pages push origin gh-pages
```

确认 GitHub Actions 中对应提交的 `pages build and deployment` 运行成功后，访问公开网址。本项目没有设置自动从 `master` 同步到 `gh-pages` 的自定义工作流。

## 完整服务端源码

`master` 同时保留最初的 Vinext / React / Cloudflare Workers 服务端实现。两个运行入口共用收藏界面和输入校验：

| 内容 | GitHub Pages 入口 | 服务端入口 |
| --- | --- | --- |
| 入口 | `pages/main.tsx` | `app/page.tsx` |
| 构建 | `pnpm build:pages` | `pnpm build` |
| 存储 | 当前浏览器 IndexedDB | 按登录用户隔离的 D1 数据库 |
| 分享文字处理 | 本地提取 | 服务端提取 |
| 只有作品链接 | 留存来源，提示补正文 | 尝试读取可访问的公开页面信息 |
| 身份 | 不需要登录 | 托管平台提供的 ChatGPT 身份 |

服务端实现会限制远程读取的域名、跳转、响应大小与时间；作品 JSON 必须匹配目标作品，通用平台简介不能充当正文。遇到验证、登录限制或正文缺失时保留链接。该实现同样不保证获取抖音全文。

服务端版本需要支持 Workers、D1 和可信身份注入的托管环境，不能直接在 GitHub Pages 执行。`.openai/hosting.json` 只保留 D1 绑定声明，不绑定此前部署的站点；发布新实例时需通过对应平台建立项目身份及数据库。`app/chatgpt-auth.ts` 依赖可信网关注入的身份头，不能在允许访客自行伪造这些头的环境中直接使用。

## 代码结构

```text
pages/                   GitHub Pages 的 HTML 和 React 入口
app/notebook.tsx         共享收藏界面
app/globals.css          响应式界面样式
app/lib/parse-share.ts   抖音分享清理、链接识别与公开页文本提取
app/lib/local-api.ts     浏览器 IndexedDB 存储及本地请求适配
app/lib/validation.ts    收藏输入校验
app/api/                原服务端收藏与解析接口
db/                     D1 / Drizzle 数据库结构
drizzle/                数据库迁移
tests/                  核心逻辑及服务端接口测试
vite.pages.config.ts    GitHub Pages 构建配置
scripts/build-pages.mjs  生成网页及发布所需文件
```

## 数据格式与限制

每条收藏保留标题、正文、作者备注、抖音来源、原始分享、分类、标签、星标和时间。JSON 备份使用 `format: "wenfeng"`、`version: 1`，可与原服务端版互相导入。

- 正文最多 50,000 字，原始分享最多 24,000 字，每条最多 12 个标签。
- 收藏与回收站合计最多 5,000 条；浏览器实际可用容量也受设备和站点存储配额影响。
- JSON 导入文件最多 20 MB，分批提交；同一批次校验失败时不会写入部分记录，重试会跳过之前批次已导入的内容。
- 相同记录 ID、可识别的相同抖音作品，以及没有来源链接的相同标题正文会去重。短链接与长链接之间不会为了去重而额外访问抖音。
- 导出仅包含已保存且未放入回收站的收藏，不含未保存的示例。

## 验证

```sh
pnpm test
pnpm typecheck
pnpm build:pages
```

服务端测试运行实际路由、输入校验、身份助手和 Drizzle schema，以内存 SQLite 代替 D1 传输，以合成身份代替托管请求头。公开页解析使用受控 HTTP 响应。浏览器存储测试覆盖收藏操作、来源去重、导入校验、回收站以及事务提交行为。

测试和生产构建不能代替真实设备验收。发布时还应检查 GitHub Pages 部署结果，以及手机和桌面浏览器中的保存、刷新后读取、备份恢复与布局。

## 许可证

MIT，见 [LICENSE](LICENSE)。保留在 `vendor/`、`build/` 中的第三方许可证同样适用。网页构建会生成 `THIRD_PARTY_NOTICES.txt`，随 `gh-pages` 一起发布页面运行依赖的完整许可证。
