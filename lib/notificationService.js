// 通知服务模块
// 提供多种微信通知方式，支持企业微信机器人、WxPusher和Server酱

class NotificationServiceClass {
  constructor() {
    // 通知服务配置
    this.config = {
      strategyName: '交易策略',
      wxPusherTokens: ['AT_dMjPttrnlSqU9uKlpW7oxkGzVynM2RkD'],
      wxPusherUids: ['UID_fG02ooNJzDTHmyv4Lhh0JFAPPBC4', 'UID_MB31nZrc9wG0D9baIFdQuZshiRLU'],
      topicIds: []
    }

    // 记录上一次通知的信号类型，按指数存储
    this.lastNotificationType = {}

    // 收集所有通知消息
    this.notificationMessages = []
  }

  // 配置通知服务
  setConfig (config) {
    this.config = {
      ...this.config,
      ...config
    }
  }

  // 添加通知消息
  addNotification (message, signalType, indexSymbol) {
    try {
      // 检查信号类型是否变化
      if (this.lastNotificationType[indexSymbol] === signalType) {
        console.log(`信号类型未变化，跳过通知: ${signalType} for ${indexSymbol}`)
        return
      }

      // 收集消息
      this.notificationMessages.push(message)
      // 更新最后通知类型
      this.lastNotificationType[indexSymbol] = signalType
    } catch (error) {
      console.error('添加通知消息失败:', error)
    }
  }

  // 发送所有收集的通知
  async sendAllNotifications () {
    if (this.notificationMessages.length === 0) {
      console.log('没有新的通知需要发送')
      return { messageCount: 0, sentCount: 0, failedCount: 0 }
    }

    // 合并所有消息
    const combinedMessage = this.notificationMessages.join('\n\n')
    const messageCount = this.notificationMessages.length
    let result = { sentCount: 0, failedCount: 0 }

    // 发送WxPusher通知
    if (this.config.wxPusherTokens && this.config.wxPusherTokens.length > 0) {
      result = await this.sendWxPusherNotifications(combinedMessage)
    }



    // 清空消息列表
    this.notificationMessages = []
    return { messageCount, ...result }
  }



  // 发送WxPusher通知
  async sendWxPusherNotifications (message) {
    let sentCount = 0
    let failedCount = 0

    for (let i = 0; i < this.config.wxPusherTokens.length; i++) {
      const token = this.config.wxPusherTokens[i]
      if (token) {
        try {
          const response = await fetch('https://wxpusher.zjiecode.com/api/send/message', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              appToken: token,
              content: `## ${this.config.strategyName}通知\n\n${message}`,
              contentType: 3, // 3表示Markdown格式
              uids: this.config.wxPusherUids, // 用户UID
              topicIds: this.config.topicIds // 也可以通过topicId发送
            }),
          })
          const data = await response.json()
          if (!response.ok || (data.code && data.code !== 1000)) {
            failedCount += 1
          } else {
            sentCount += 1
          }
          console.log(`WxPusher通知发送结果 [用户${i + 1}]:`, data)
        } catch (error) {
          failedCount += 1
          console.error(`WxPusher通知发送失败 [用户${i + 1}]:`, error)
        }
      }
    }

    return { sentCount, failedCount }
  }


}

// 导出单例实例
const NotificationService = new NotificationServiceClass()

if (typeof module !== 'undefined' && module.exports) {
  module.exports = NotificationService
} else if (typeof window !== 'undefined') {
  window.NotificationService = NotificationService
}

export default NotificationService
