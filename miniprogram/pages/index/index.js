// miniprogram/pages/index/index.js
Page({
    /**
     * 页面的初始数据
     */
    data: {
      macAddress: null, // 用于存储从二维码获取的MAC地址
      isLoading: true,  // 控制加载状态的显示
      error: null,      // 存放错误信息
      userInfo: null,   // 存储用户信息（包含电量等）
      batteryLevel: null, // 用户电量百分比
      balance: null,    // 用户余额
      totalRequests: null, // 总请求数
      totalCost: null,  // 总花费
      isLoadingUserInfo: false, // 控制用户信息加载状态
      // BLE 配网
      provisionSsid: '',
      provisionPwd: '',
      bleDeviceId: null,
      bleDeviceName: null,
      bleServiceId: '0000fff0-0000-1000-8000-00805f9b34fb',
      bleWriteCharId: '0000fff1-0000-1000-8000-00805f9b34fb'
    },
  
    /**
     * 生命周期函数--监听页面加载
     * options 对象包含了小程序启动时的参数
     */
    onLoad(options) {
      console.log('小程序启动参数 options:', options);
      
      let mac = null;
      
      // 方法1: 处理二维码scene参数
      if (options.scene) {
        const scene = decodeURIComponent(options.scene);
        console.log('解码后的scene:', scene);
        
        if (scene.startsWith('mac=')) {
          mac = scene.split('=')[1];
          console.log('从scene解析出的MAC地址:', mac);
        }
      }
      
      // 方法2: 处理直接传入的mac参数（用于开发测试）
      if (!mac && options.mac) {
        mac = options.mac;
        console.log('从mac参数获取的MAC地址:', mac);
      }
  
      if (mac) {
        // 使用 setData 更新页面数据，将MAC地址显示出来
        this.setData({
          macAddress: mac,
          isLoading: false
        });
  
        // 自动获取用户信息
        this.fetchUserInfo(mac);
      } else {
        // 如果没有获取到MAC地址
        console.error('未找到有效的MAC地址', options);
        this.setData({
          isLoading: false,
          error: '无效的二维码或参数，请扫描正确的设备码。'
        });
      }
    },
  
    /** BLE 配网：输入 **/
    onInputSsid(e) {
      this.setData({ provisionSsid: e.detail.value });
    },
    onInputPwd(e) {
      this.setData({ provisionPwd: e.detail.value });
    },
  
    /** 扫描并连接 BLE 设备 **/
    onScanBleClick() {
      wx.openBluetoothAdapter({
        success: () => {
          wx.startBluetoothDevicesDiscovery({
            allowDuplicatesKey: false,
            powerLevel: 'high',
            success: () => {
              // 简化：监听一次回调后立即停止扫描并连接首个匹配设备（包含 Xiaozhi 或提供 FFF0 服务）
              const onFound = (res) => {
                const devices = res.devices || [];
                const target = devices.find(d => (d.name && d.name.includes('Xiaozhi')) || (d.advertisServiceUUIDs || []).some(u => /fff0/i.test(u)));
                if (target) {
                  wx.offBluetoothDeviceFound(onFound);
                  wx.stopBluetoothDevicesDiscovery({});
                  this.connectBle(target);
                }
              };
              wx.onBluetoothDeviceFound(onFound);
              // 兜底：5 秒后停止
              setTimeout(() => {
                wx.stopBluetoothDevicesDiscovery({});
              }, 5000);
            }
          });
        },
        fail: (err) => {
          wx.showToast({ title: '蓝牙未开启', icon: 'none' });
          console.error(err);
        }
      });
    },
  
    connectBle(device) {
      wx.createBLEConnection({
        deviceId: device.deviceId,
        success: () => {
          this.setData({ bleDeviceId: device.deviceId, bleDeviceName: device.name || device.localName || '设备' });
          // 使能通知（不强求）
          wx.getBLEDeviceServices({
            deviceId: device.deviceId,
            success: (res) => {
              console.log('services:', res.services);
              // 可选：检查是否存在期望服务
            }
          });
        },
        fail: (err) => {
          wx.showToast({ title: '连接失败', icon: 'none' });
          console.error(err);
        }
      });
    },
  
    /** 发送凭据 **/
    onSendProvisionClick() {
      const { provisionSsid, provisionPwd, bleDeviceId, bleServiceId, bleWriteCharId } = this.data;
      if (!bleDeviceId) {
        wx.showToast({ title: '请先连接设备', icon: 'none' });
        return;
      }
      if (!provisionSsid) {
        wx.showToast({ title: '请输入WiFi名称', icon: 'none' });
        return;
      }
      const payload = `${provisionSsid}\n${provisionPwd || ''}`;
      const buffer = (function utf8Encode(str) {
        const bytes = [];
        for (let i = 0; i < str.length; i++) {
          let code = str.charCodeAt(i);
          if (code < 0x80) {
            bytes.push(code);
          } else if (code < 0x800) {
            bytes.push(0xc0 | (code >> 6));
            bytes.push(0x80 | (code & 0x3f));
          } else if (code >= 0xd800 && code <= 0xdbff) {
            const hi = code;
            const low = str.charCodeAt(++i);
            const cp = ((hi - 0xd800) << 10) + (low - 0xdc00) + 0x10000;
            bytes.push(0xf0 | (cp >> 18));
            bytes.push(0x80 | ((cp >> 12) & 0x3f));
            bytes.push(0x80 | ((cp >> 6) & 0x3f));
            bytes.push(0x80 | (cp & 0x3f));
          } else {
            bytes.push(0xe0 | (code >> 12));
            bytes.push(0x80 | ((code >> 6) & 0x3f));
            bytes.push(0x80 | (code & 0x3f));
          }
        }
        return new Uint8Array(bytes);
      })(payload);

      // 分片写入（每包最多 20 字节，兼容多数机型）
      const mtu = 20;
      let offset = 0;
      const writeNext = () => {
        if (offset >= buffer.length) {
          wx.showToast({ title: '已发送', icon: 'success' });
          return;
        }
        const slice = buffer.slice(offset, Math.min(offset + mtu, buffer.length));
        offset += slice.length;
        wx.writeBLECharacteristicValue({
          deviceId: bleDeviceId,
          serviceId: bleServiceId,
          characteristicId: bleWriteCharId,
          value: slice.buffer,
          success: () => writeNext(),
          fail: (err) => {
            console.error('write failed', err);
            wx.showToast({ title: '发送失败', icon: 'none' });
          }
        });
      };

      // 确保已获取特征（部分机型需要先调用 getBLEDeviceCharacteristics）
      wx.getBLEDeviceCharacteristics({
        deviceId: bleDeviceId,
        serviceId: bleServiceId,
        success: () => writeNext(),
        fail: (err) => {
          console.error('get chars failed', err);
          wx.showToast({ title: '蓝牙服务不可用', icon: 'none' });
        }
      });
    },
  
    /**
     * 获取单个用户信息（包含电量、余额等）
     * @param {string} mac - MAC地址作为用户ID
     */
    fetchUserInfo(mac) {
      this.setData({ isLoadingUserInfo: true });
      
      // URL编码MAC地址，处理冒号等特殊字符
      const encodedMac = encodeURIComponent(mac);
      
      wx.request({
        url: `https://hmbbserver.top/users/${encodedMac}`, // 使用编码后的MAC地址
        method: 'GET',
        header: {
          'Content-Type': 'application/json'
        },
        success: (res) => {
          console.log('用户信息API响应:', res);
          console.log('响应数据:', JSON.stringify(res.data));
          
          if (res.statusCode === 200) {
            // 根据API响应格式解析数据
            let userData = null;
            
            // 如果响应格式是 {"status": "success", "data": {...}}
            if (res.data.status === 'success' && res.data.data) {
              userData = res.data.data;
            }
            // 如果响应格式直接是用户数据 {...}
            else if (res.data.user_id || res.data.balance !== undefined) {
              userData = res.data;
            }
            
            if (userData) {
              this.setData({
                userInfo: userData,
                batteryLevel: userData.battery,
                balance: userData.balance,
                totalRequests: userData.total_requests,
                totalCost: userData.total_cost,
                error: null // 清除之前的错误
              });
            } else {
              this.setData({
                error: '用户数据格式异常，请联系技术支持'
              });
            }
          } else if (res.statusCode === 404) {
            this.setData({
              error: '未找到该设备的用户信息，请检查设备码是否正确'
            });
          } else {
            console.error('获取用户信息失败:', res);
            let errorMsg = '获取用户信息失败';
            if (res.data && res.data.error) {
              errorMsg += `: ${res.data.error}`;
            } else if (res.data && res.data.message) {
              errorMsg += `: ${res.data.message}`;
            }
            this.setData({ 
              error: errorMsg
            });
          }
        },
        fail: (err) => {
          console.error('网络请求失败:', err);
          this.setData({ 
            error: '网络请求失败，请检查网络连接' 
          });
        },
        complete: () => {
          this.setData({ isLoadingUserInfo: false });
        }
      });
    },
  
    /**
     * 刷新用户信息
     */
    refreshUserInfo() {
      if (this.data.macAddress) {
        // 清除之前的错误信息
        this.setData({ error: null });
        this.fetchUserInfo(this.data.macAddress);
      }
    },
  
    /**
     * 充值按钮点击事件
     */
    onRechargeClick() {
      if (this.data.macAddress) {
        // 调用充值API
        this.rechargeUser(this.data.macAddress, 100); // 默认充值100元
      }
    },
  
    /**
     * 用户充值功能
     * @param {string} mac - MAC地址作为用户ID
     * @param {number} amount - 充值金额
     */
    rechargeUser(mac, amount) {
      wx.showLoading({ title: '充值中...' });
      
      // URL编码MAC地址，处理冒号等特殊字符
      const encodedMac = encodeURIComponent(mac);
      
      wx.request({
        url: `https://hmbbserver.top/users/${encodedMac}/recharge`, // 改为HTTPS域名
        method: 'POST',
        header: {
          'Content-Type': 'application/json'
        },
        data: {
          amount: amount
        },
        success: (res) => {
          console.log('充值API响应:', res);
          if (res.statusCode === 200 && res.data.status === 'success') {
            wx.showToast({
              title: `充值成功！充值金额：${amount}元`,
              icon: 'success',
              duration: 2000
            });
            // 充值成功后刷新用户信息
            setTimeout(() => {
              this.fetchUserInfo(mac);
            }, 1000);
          } else {
            let errorMsg = '充值失败';
            if (res.data && res.data.error) {
              errorMsg += `: ${res.data.error}`;
            } else if (res.data && res.data.message) {
              errorMsg += `: ${res.data.message}`;
            }
            wx.showToast({
              title: errorMsg,
              icon: 'none'
            });
          }
        },
        fail: (err) => {
          console.error('充值请求失败:', err);
          wx.showToast({
            title: '充值失败，请检查网络',
            icon: 'none'
          });
        },
        complete: () => {
          wx.hideLoading();
        }
      });
    },

    /**
     * 用户电池电量充值功能
     * @param {string} mac - MAC地址作为用户ID
     * @param {number} batteryAmount - 充值电量
     */
    rechargeBattery(mac, batteryAmount) {
      wx.showLoading({ title: '电量充值中...' });
      
      // URL编码MAC地址，处理冒号等特殊字符
      const encodedMac = encodeURIComponent(mac);
      
      wx.request({
        url: `https://hmbbserver.top/users/${encodedMac}/battery`,
        method: 'POST',
        header: {
          'Content-Type': 'application/json'
        },
        data: {
          battery: batteryAmount
        },
        success: (res) => {
          console.log('电量充值API响应:', res);
          if (res.statusCode === 200 && res.data.status === 'success') {
            wx.showToast({
              title: `电量充值成功！充值电量：${batteryAmount}%`,
              icon: 'success',
              duration: 2000
            });
            // 充值成功后刷新用户信息
            setTimeout(() => {
              this.fetchUserInfo(mac);
            }, 1000);
          } else {
            let errorMsg = '电量充值失败';
            if (res.data && res.data.error) {
              errorMsg += `: ${res.data.error}`;
            } else if (res.data && res.data.message) {
              errorMsg += `: ${res.data.message}`;
            }
            wx.showToast({
              title: errorMsg,
              icon: 'none'
            });
          }
        },
        fail: (err) => {
          console.error('电量充值请求失败:', err);
          wx.showToast({
            title: '电量充值失败，请检查网络',
            icon: 'none'
          });
        },
        complete: () => {
          wx.hideLoading();
        }
      });
    },

    /**
     * 电量充值按钮点击事件
     */
    onBatteryRechargeClick() {
      if (this.data.macAddress) {
        // 调用电量充值API
        this.rechargeBattery(this.data.macAddress, 20); // 默认充值20%电量
      }
    }
});