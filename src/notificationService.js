// 通知服务模块
// 提供多种微信通知方式，支持企业微信机器人、WxPusher和Server酱

class NotificationServiceClass {
  constructor() {
    // 通知服务配置
    this.config = {
      wxPusherTokens: ['AT_dMjPttrnlSqU9uKlpW7oxkGzVynM2RkD'],
    }

    // 记录上一次通知的信号类型，按指数存储
    this.lastNotificationType = {}

    // 收集所有通知消息
    this.notificationMessages = []
  }

  // 配置通知服务
  setConfig (config) {
    this.config = {
      strategyName: '交易策略', // 默认策略名称
      ...this.config,
      ...config
    }
  }

  // 添加通知消息
  addNotification (message, signalType, indexSymbol) {
    try {
      // 检查信号类型是否变化（仅在 signalType 不为空且 indexSymbol 不为空时检查）
      if (signalType && indexSymbol && this.lastNotificationType[indexSymbol] === signalType) {
        console.log(`信号类型未变化，跳过通知: ${signalType} for ${indexSymbol}`)
        return
      }

      // 收集消息
      this.notificationMessages.push(message)
      // 更新最后通知类型
      if (indexSymbol) {
        this.lastNotificationType[indexSymbol] = signalType
      }
    } catch (error) {
      console.error('添加通知消息失败:', error)
    }
  }

  // 添加通知消息（不检查信号类型，强制发送）
  addNotificationForce (message, indexSymbol = 'default') {
    try {
      // 直接收集消息，不做信号类型检查
      this.notificationMessages.push(message)
      console.log(`[NotificationService] 强制添加通知: ${indexSymbol}, 消息长度: ${message.length}`)
    } catch (error) {
      console.error('[NotificationService] 添加通知消息失败:', error)
    }
  }

  // 发送所有收集的通知
  async sendAllNotifications () {
    console.log('[NotificationService] sendAllNotifications 开始')
    console.log('[NotificationService] 待发送消息数量:', this.notificationMessages.length)

    if (this.notificationMessages.length === 0) {
      console.log('[NotificationService] 没有新的通知需要发送')
      return
    }

    // 合并所有消息
    const combinedMessage = this.notificationMessages.join('\n\n')
    console.log('[NotificationService] 合并后的消息长度:', combinedMessage.length)

    // 发送WxPusher通知
    if (this.config.wxPusherTokens && this.config.wxPusherTokens.length > 0) {
      console.log('[NotificationService] 开始发送WxPusher通知...')
      await this.sendWxPusherNotifications(combinedMessage)
    } else {
      console.warn('[NotificationService] 未配置 wxPusherTokens')
    }

    // 清空消息列表
    this.notificationMessages = []
    console.log('[NotificationService] 消息列表已清空')
    console.log('[NotificationService] sendAllNotifications 结束')
  }



  // 发送WxPusher通知
  async sendWxPusherNotifications (message) {
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
              uids: ['UID_fG02ooNJzDTHmyv4Lhh0JFAPPBC4', 'UID_MB31nZrc9wG0D9baIFdQuZshiRLU'], // 用户UID
              topicIds: [] // 也可以通过topicId发送
            }),
          })
          const data = await response.json()
          console.log(`WxPusher通知发送结果 [用户${i + 1}]:`, data)
        } catch (error) {
          console.error(`WxPusher通知发送失败 [用户${i + 1}]:`, error)
        }
      }
    }
  }


}

// 导出单例实例
const NotificationService = new NotificationServiceClass()

// 直接定义为全局变量（优先）
if (typeof window !== 'undefined') {
  window.NotificationService = NotificationService
}

// CommonJS 导出（兼容 Node.js）
if (typeof module !== 'undefined' && module.exports) {
  module.exports = NotificationService
  module.exports.default = NotificationService
}
