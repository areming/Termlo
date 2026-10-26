# Termlo · 中文介绍

[返回首页中文部分](README.md#中文) · [English](README.md#english)

Termlo 是本地优先的 SSH、SFTP 与服务器智能体桌面工具。桌面端使用 Electron 与 JavaScript。首页提供中英双语，点击上方链接即可在同一个首页查看介绍。

查看[主机与项目空间](docs/intro/hosts.md)、[终端与 SFTP](docs/intro/terminal.md)、[智能助手](docs/intro/agent.md)和[账户服务部署](docs/intro/account-api.md)。所有介绍图均为虚构数据制作的示意图。

当前版本为 **1.2.0**，安装包见 [GitHub Releases](https://github.com/areming/Termlo/releases)。首次启动可按欢迎页依次选择使用方式、添加主机和配置模型，也可跳过并在对应模块继续。普通 SSH 使用无需登录；登录远程账户后，空间、主机配置和非密钥模型设置可加密同步。SSH 密码、私钥和模型 API 密钥仍只保存在本机。用户服务的一键部署使用固定脚本，不消耗模型调用。服务接口与 Swagger 详见[用户 API 文档](services/user-api/README.md)。
