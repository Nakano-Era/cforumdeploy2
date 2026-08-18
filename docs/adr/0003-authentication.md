# ADR 0003：无密码认证与会话

- 状态：已接受
- 日期：2026-08-16

## 决策

Passkey/WebAuthn 是推荐登录方式，但注册时不强制创建；邮箱 OTP 可完成注册、备用登录和恢复。UI 在注册成功后强提示设置 Passkey。

WebAuthn 使用 `@simplewebauthn/server` 与浏览器配套库，严格校验 RP ID、Origin、Challenge、用户验证标志和签名计数。Challenge 只保存带独立密钥的 HMAC，五分钟过期并原子消费。

OTP 使用 Web Crypto 生成无偏 8 位数字码。D1 只保存：

```text
HMAC(secret, framed(challenge_id, normalized_email, code))
```

验证码十分钟过期、最多五次、重发冷却 60 秒；每邮箱每小时 5 次、每日 10 次。验证成功后，数据库中的验证码 HMAC 被原子轮换成一次性验证票据 HMAC，注册或登录流程再消费该票据。

## 会话

会话 token 只存在客户端 Cookie，数据库只存 HMAC。Cookie 使用 `Secure`、`HttpOnly`、`SameSite=Lax`、`Path=/`；CSRF 使用同会话绑定的随机 token、Strict Cookie、请求头和严格 Origin 校验。会话可单独或全设备吊销。

所有认证、邀请、恢复和上传许可的令牌使用独立用途与域分隔。生产环境邮件未配置时，公开验证码流程统一返回接受响应但不发码，避免账户枚举并 fail closed。

## 非目标

首版不支持密码。若以后增加密码，必须另行评审经过审计的 KDF 或专用身份服务，不能在 Worker 中自行设计密码哈希。
