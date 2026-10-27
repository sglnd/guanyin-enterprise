# License 与固定公钥

本包沿用观因企业版长期使用的 Ed25519 验签公钥。
`kubernetes.yaml` 中 `guanyin-production-config.data.licensePublicKey` 与
`guanyin-license-public.pem` 内容一致。

部署时不要重新生成密钥对，不要替换公钥。已签发的授权必须由匹配的长期私钥签名。
私钥只保留在受控的授信签发项目中，不随部署包交付。

激活流程：在已有授信签发项目中，使用既有私钥按客户名称、有效期和授权额度签发，
再在观因登录页的 License 激活区域填写对应客户名称并导入授权。
客户名称应与签发内容一致。升级已有企业环境时保留原数据库、Secret 和固定公钥，
不需要因升级空间版本而重新生成密钥。

可在交付目录查看公钥指纹并与签发系统公钥核对：

```bash
openssl pkey -pubin -in guanyin-license-public.pem -outform DER | openssl dgst -sha256
```

本包不附带已签发的客户 License，也不包含任何签发私钥。
