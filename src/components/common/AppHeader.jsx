import React from 'react';
import { Space, Badge, Button, Switch, Typography } from 'antd';
import {
  ApiOutlined,
  CheckCircleOutlined,
  StopOutlined,
  BulbOutlined,
  BulbFilled,
} from '@ant-design/icons';
import './AppHeader.css';

const { Text } = Typography;

export function AppHeader({ proxyStatus, onToggleProxy, theme, onThemeChange }) {
  const isDark = theme === 'dark';

  return (
    <header className={`app-header ${theme}`}>
      <div className="header-left">
        <Space size="large">
          <div className="logo">
            <ApiOutlined className="logo-icon" />
            <span className="logo-text">AgentProxy</span>
          </div>
          <Badge
            status={proxyStatus.running ? 'processing' : 'default'}
            text={
              <Space size="small">
                <Text type="secondary">
                  {proxyStatus.running ? `端口 ${proxyStatus.port}` : '未运行'}
                </Text>
              </Space>
            }
          />
        </Space>
      </div>

      <div className="header-center">
        <Space size="middle">
          <div className="proxy-control">
            <Text type="secondary" className="control-label">
              代理状态:
            </Text>
            <Switch
              checked={proxyStatus.enabled}
              onChange={onToggleProxy}
              checkedChildren={<CheckCircleOutlined />}
              unCheckedChildren={<StopOutlined />}
            />
          </div>
          <Badge
            status={proxyStatus.enabled ? 'success' : 'default'}
            text={proxyStatus.enabled ? '已启用' : '已禁用'}
          />
        </Space>
      </div>

      <div className="header-right">
        <Space>
          <Button
            type="text"
            icon={isDark ? <BulbFilled /> : <BulbOutlined />}
            onClick={() => onThemeChange(isDark ? 'light' : 'dark')}
          />
        </Space>
      </div>
    </header>
  );
}
