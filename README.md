# NeoBot Dashboard

一个用于 [NeoBot](https://github.com/SuperQuail/NeoBot) 的网页仪表盘插件，可以在浏览器中查看 Bot 运行状态、插件状态、日志、系统资源占用、消息统计等信息，并提供基础的插件管理能力。

## 主要功能
  - 监测 NeoBot 在线状态
  - 查看 Bot 昵称、QQ号、头像
  - 监测运行时长、今日消息数、累计消息数
  - 监测插件数量与加载状态

---

## 安装方法

### 方法一：手动安装

进入 NeoBot 插件目录：

```text
cd /root/neobot/app/data/plugins
```

下载或复制本插件到 `dashboard` 目录：

```text
git clone https://github.com/momomiso/NeoBot_Dashboard.git dashboard
```
## 启动方法

**_<span style="color: #639bff; ">必须先构建</span>[NeoBot](https://github.com/SuperQuail/NeoBot)<span style="color: #639bff; ">后才能正常启动</span>_**

服务端防火墙放行8083端口

回到 NeoBot 根目录并启动：
```text
cd /root/neobot
uv run Bot.py
```

启动成功后，控制台会打印登录信息：

```text
访问地址: http://0.0.0.0:8083/
Access Token:
xxxxxxxxxxxxxxx
```

浏览器打开：

```text
http://服务器IP:8083
```

然后输入控制台显示的 Access Token 登录。

---

## 配置文件

配置文件位置：

```text
dashboard/plugin.toml
```

## 更新方法
1)推荐直接从Github上直接拉取最新的版本手动覆盖旧文件

2)从网页中的插件管理界面更新,但可能更新时间较长,且必须重启bot才能重新运行

## 卸载方法
<span style="color: #639bff; ">
该插件只能使用命令卸载。
</span>

停止 NeoBot 后，删除插件目录：

```text
rm -rf /root/neobot/app/data/plugins/dashboard
```

如果需要同时删除插件数据，可以删除对应plugins_data目录中的 dashboard 数据。

---

## 鸣谢
- [NeoBot](https://github.com/SuperQuail/NeoBot)
