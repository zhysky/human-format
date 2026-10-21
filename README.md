# human-format

用统一的命令整理当前改动的前端代码。默认使用 Oxfmt，也可以选择 dprint 或 Biome。

工具和引擎安装在项目之外。格式化只写工作区文件，保留 Git 暂存区，不修改项目的依赖、锁文件和格式配置。

## 安装

需要 Node.js 22.20.0 或更新版本，以及 npm。在 Git 仓库中自动选择改动文件时，还需要 Git。

macOS、Linux 和 Windows 均使用这条命令：

```bash
npm install -g https://github.com/zhysky/human-format/releases/latest/download/human-format.tgz
```

macOS 和 Linux 也可以运行安装脚本：

```bash
curl -fsSL https://raw.githubusercontent.com/zhysky/human-format/main/install.sh | bash
```

安装包来自本仓库的 GitHub Releases，无需登录 npm。安装完成后执行 `human-format --list-engines`，确认三个引擎均可运行。

如果系统的 npm 全局目录不可写，可以指定用户目录：

```bash
HUMAN_FORMAT_INSTALL_PREFIX="$HOME/.local" bash install.sh
```

这条命令用于已下载或克隆的仓库。使用自定义目录时，需要把对应的可执行文件目录加入 `PATH`。在 macOS 和 Linux 上，上例对应 `~/.local/bin`。

## 使用

```bash
human-format                    # 用 Oxfmt 格式化当前改动的代码文件
human-format --check            # 检查格式，不写源文件
human-format -e dprint          # 使用 dprint
human-format -e biome           # 使用 Biome
human-format --list-files       # 查看将处理哪些文件
human-format --list-engines     # 查看引擎版本
human-format --tool-version     # 查看 human-format 版本
human-format src/example.ts     # 处理指定文件
```

默认合并已暂存、未暂存和未跟踪的代码文件，去重后处理。未跟踪文件遵守 Git 忽略规则。已删除文件和符号链接会跳过，没有改动时直接结束。

默认选择 JavaScript、TypeScript、Vue、HTML、CSS、SCSS 和 Less 文件。显式传入文件时，必须提供文件路径；目录和未展开的通配符会报错。以 `-` 开头的文件名放在 `--` 后面。

### 排版预设

默认使用 100 列行宽、2 个空格缩进、单引号，以及尽量省略分号的排版。Vue 属性逐行显示。预设不启用导入排序。

这些选项只调整格式，不负责拆分函数、重命名变量或修改业务结构。很长的表达式如何换行，由所选引擎决定。

### Vue 兼容处理

Oxfmt 和 dprint 处理模板与脚本。Biome 只处理 Vue 脚本，保留模板与样式；显式选择 Biome 时，不支持的 HTML、SCSS 和 Less 文件会报错。

工具会原样保留 Stylus 等不支持语言的样式内容，避免改变有语义的缩进。TypeScript 脚本中的单参数泛型箭头函数会保留 `<T,>`，兼容把 `<T>` 当作 JSX 的解析器。

## 更新引擎

```bash
human-format update                   # 更新三个引擎
human-format update -e biome          # 只更新 Biome
human-format update -e dprint         # 更新 dprint 和三个格式插件
human-format update --check           # 只查看可更新版本
```

更新目标是 npm 的 `latest` 标签。dprint 的 TypeScript、Vue/HTML 和 CSS 插件一起参与版本核对。更新只写工具自己的引擎目录。

更新后会检查 TypeScript、CSS 和 Vue 格式化，并核对 Stylus 内容、泛型逗号及检查模式不写入。安装或验证失败时，会尝试恢复原版本，并报告恢复结果。

`update` 只更新底层引擎。升级 human-format 本身时，重新执行安装命令。

## 回退引擎

```bash
human-format rollback                   # 回退最近一批尚可回退的成功更新
human-format rollback -e oxfmt          # 回退 Oxfmt 最近一次更新
human-format rollback -e dprint         # 同时还原 dprint 和三个格式插件
human-format rollback -e biome          # 回退 Biome 最近一次更新
human-format rollback --check           # 预览版本，不执行回退
```

记录按引擎维护。先回退一个引擎后，其余引擎仍可继续回退。有多次成功更新时，可以重复执行，逐次回到更早版本。首次安装和“已经是最新版本”的检查不产生回退记录。

当前版本必须与记录中的更新结果一致。通过其他方式改过版本时，回退会停止。回退失败时，工具会尝试恢复到执行命令前的版本。

Biome 回退会恢复对应的配置版本声明，保留后来修改过的个人排版选项。回退版本需要从 npm 下载，或命中本地 npm 缓存；记录中保存的是版本和配置，不包含引擎二进制副本。

## 用户目录

首次安装的引擎随全局 npm 包提供。之后的引擎更新、缓存和回退记录默认保存在 `~/.local/share/human-format/`，与项目目录分开。

你可以把仓库中的 `presets/oxfmt.json`、`presets/dprint.json` 或 `presets/biome.json` 复制到 `~/.config/human-format/`，再修改个人排版选项。没有个人配置时，工具使用内置预设。dprint 配置中的插件包名会自动解析为当前安装位置。

- `HUMAN_FORMAT_HOME`：指定独立的数据目录。设置后，默认配置目录也改为其中的 `config/`，适合隔离测试。
- `HUMAN_FORMAT_CONFIG_DIR`：单独指定个人配置目录。
- `HUMAN_FORMAT_NPM_CLI`：在特殊 Node.js 安装布局下，指定 `npm-cli.js` 的路径。

Windows 中的 `~` 表示当前用户主目录。安装目录由 npm 的全局安装位置决定。工具不修改 Shell 配置，也不会覆盖单独安装的 `oxfmt`、`dprint` 或 `biome` 命令。

## 开发与验证

```bash
npm ci
npm test
npm run test:install
npm run test:versions
```

单元与回归测试覆盖文件选择、三个引擎的格式检查、Vue 兼容和版本记录。安装测试会打包并安装到临时目录。版本测试会在独立引擎目录中实测 Oxfmt 升级与回退；这两项测试需要联网下载依赖。

`bin/` 是命令入口，`src/` 包含运行时路径、文件选择、Vue 兼容和引擎管理，`presets/` 保存默认排版选项。持续集成在 Linux、macOS 和 Windows 上运行测试。

## 许可证

[MIT](LICENSE)。三个格式引擎及其依赖沿用各自许可证。
