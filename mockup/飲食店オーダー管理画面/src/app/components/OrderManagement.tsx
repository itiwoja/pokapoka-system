import { useState } from 'react';
import {
  Card,
  CardContent,
  CardHeader,
  Chip,
  Grid,
  Typography,
  Button,
  Tabs,
  Tab,
  Box,
  IconButton,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  List,
  ListItem,
  ListItemText,
  Divider,
} from '@mui/material';
import {
  Restaurant,
  Schedule,
  CheckCircle,
  LocalShipping,
  Cancel,
  Refresh,
} from '@mui/icons-material';

interface OrderItem {
  id: string;
  name: string;
  quantity: number;
  price: number;
  notes?: string;
}

interface Order {
  id: string;
  tableNumber: string;
  items: OrderItem[];
  status: 'pending' | 'preparing' | 'ready' | 'completed' | 'cancelled';
  timestamp: Date;
  total: number;
  customerName?: string;
}

const mockOrders: Order[] = [
  {
    id: 'ORD-001',
    tableNumber: 'テーブル 5',
    items: [
      { id: '1', name: 'カルボナーラ', quantity: 2, price: 1200 },
      { id: '2', name: 'シーザーサラダ', quantity: 1, price: 800 },
      { id: '3', name: 'アイスコーヒー', quantity: 2, price: 400 },
    ],
    status: 'pending',
    timestamp: new Date(Date.now() - 5 * 60000),
    total: 3600,
  },
  {
    id: 'ORD-002',
    tableNumber: 'テーブル 3',
    items: [
      { id: '4', name: 'マルゲリータピザ', quantity: 1, price: 1500 },
      { id: '5', name: 'ミネストローネ', quantity: 1, price: 600 },
    ],
    status: 'preparing',
    timestamp: new Date(Date.now() - 15 * 60000),
    total: 2100,
  },
  {
    id: 'ORD-003',
    tableNumber: 'テーブル 8',
    items: [
      { id: '6', name: 'ハンバーグステーキ', quantity: 1, price: 1800 },
      { id: '7', name: 'フライドポテト', quantity: 1, price: 500 },
      { id: '8', name: 'コーラ', quantity: 2, price: 300 },
    ],
    status: 'ready',
    timestamp: new Date(Date.now() - 25 * 60000),
    total: 2900,
  },
  {
    id: 'ORD-004',
    tableNumber: 'テーブル 12',
    items: [
      { id: '9', name: '天ぷら定食', quantity: 2, price: 1400 },
      { id: '10', name: '生ビール', quantity: 2, price: 600 },
    ],
    status: 'preparing',
    timestamp: new Date(Date.now() - 10 * 60000),
    total: 4000,
  },
  {
    id: 'ORD-005',
    tableNumber: 'テーブル 1',
    items: [
      { id: '11', name: 'チキンカレー', quantity: 1, price: 1000 },
    ],
    status: 'completed',
    timestamp: new Date(Date.now() - 45 * 60000),
    total: 1000,
  },
];

const statusConfig = {
  pending: { label: '受付済み', color: 'warning' as const, icon: Schedule },
  preparing: { label: '調理中', color: 'info' as const, icon: Restaurant },
  ready: { label: '配膳待ち', color: 'success' as const, icon: CheckCircle },
  completed: { label: '完了', color: 'default' as const, icon: LocalShipping },
  cancelled: { label: 'キャンセル', color: 'error' as const, icon: Cancel },
};

export function OrderManagement() {
  const [orders, setOrders] = useState<Order[]>(mockOrders);
  const [selectedTab, setSelectedTab] = useState(0);
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const filterOrders = (status?: Order['status']) => {
    if (!status) return orders;
    return orders.filter((order) => order.status === status);
  };

  const handleStatusChange = (orderId: string, newStatus: Order['status']) => {
    setOrders((prev) =>
      prev.map((order) =>
        order.id === orderId ? { ...order, status: newStatus } : order
      )
    );
  };

  const handleOrderClick = (order: Order) => {
    setSelectedOrder(order);
    setDialogOpen(true);
  };

  const getElapsedTime = (timestamp: Date) => {
    const minutes = Math.floor((Date.now() - timestamp.getTime()) / 60000);
    return `${minutes}分前`;
  };

  const stats = {
    pending: filterOrders('pending').length,
    preparing: filterOrders('preparing').length,
    ready: filterOrders('ready').length,
    completed: filterOrders('completed').length,
  };

  const currentOrders = [0, 1, 2, 3, 4].map((index) => {
    const statusMap: Array<Order['status'] | undefined> = [
      undefined,
      'pending',
      'preparing',
      'ready',
      'completed',
    ];
    return filterOrders(statusMap[index]);
  })[selectedTab];

  return (
    <div className="size-full p-6 bg-gray-50 overflow-auto">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <Typography variant="h4" component="h1" fontWeight="bold">
            オーダー管理
          </Typography>
          <IconButton color="primary" size="large">
            <Refresh />
          </IconButton>
        </div>

        <Grid container spacing={3} className="mb-6">
          <Grid item xs={12} sm={6} md={3}>
            <Card>
              <CardContent>
                <div className="flex items-center justify-between">
                  <div>
                    <Typography color="textSecondary" variant="body2">
                      受付済み
                    </Typography>
                    <Typography variant="h4" fontWeight="bold">
                      {stats.pending}
                    </Typography>
                  </div>
                  <Schedule sx={{ fontSize: 48, color: '#ed6c02' }} />
                </div>
              </CardContent>
            </Card>
          </Grid>
          <Grid item xs={12} sm={6} md={3}>
            <Card>
              <CardContent>
                <div className="flex items-center justify-between">
                  <div>
                    <Typography color="textSecondary" variant="body2">
                      調理中
                    </Typography>
                    <Typography variant="h4" fontWeight="bold">
                      {stats.preparing}
                    </Typography>
                  </div>
                  <Restaurant sx={{ fontSize: 48, color: '#0288d1' }} />
                </div>
              </CardContent>
            </Card>
          </Grid>
          <Grid item xs={12} sm={6} md={3}>
            <Card>
              <CardContent>
                <div className="flex items-center justify-between">
                  <div>
                    <Typography color="textSecondary" variant="body2">
                      配膳待ち
                    </Typography>
                    <Typography variant="h4" fontWeight="bold">
                      {stats.ready}
                    </Typography>
                  </div>
                  <CheckCircle sx={{ fontSize: 48, color: '#2e7d32' }} />
                </div>
              </CardContent>
            </Card>
          </Grid>
          <Grid item xs={12} sm={6} md={3}>
            <Card>
              <CardContent>
                <div className="flex items-center justify-between">
                  <div>
                    <Typography color="textSecondary" variant="body2">
                      完了
                    </Typography>
                    <Typography variant="h4" fontWeight="bold">
                      {stats.completed}
                    </Typography>
                  </div>
                  <LocalShipping sx={{ fontSize: 48, color: '#757575' }} />
                </div>
              </CardContent>
            </Card>
          </Grid>
        </Grid>

        <Card>
          <CardHeader title="注文一覧" />
          <Tabs
            value={selectedTab}
            onChange={(_, newValue) => setSelectedTab(newValue)}
            variant="scrollable"
            scrollButtons="auto"
          >
            <Tab label="すべて" />
            <Tab label="受付済み" />
            <Tab label="調理中" />
            <Tab label="配膳待ち" />
            <Tab label="完了" />
          </Tabs>
          <CardContent>
            <Grid container spacing={2}>
              {currentOrders.map((order) => {
                const StatusIcon = statusConfig[order.status].icon;
                return (
                  <Grid item xs={12} md={6} lg={4} key={order.id}>
                    <Card
                      variant="outlined"
                      sx={{
                        cursor: 'pointer',
                        '&:hover': { boxShadow: 3 },
                        transition: 'box-shadow 0.3s',
                      }}
                      onClick={() => handleOrderClick(order)}
                    >
                      <CardContent>
                        <div className="flex items-start justify-between mb-3">
                          <div>
                            <Typography variant="h6" fontWeight="bold">
                              {order.id}
                            </Typography>
                            <Typography
                              variant="body2"
                              color="textSecondary"
                            >
                              {order.tableNumber}
                            </Typography>
                          </div>
                          <Chip
                            label={statusConfig[order.status].label}
                            color={statusConfig[order.status].color}
                            size="small"
                            icon={<StatusIcon />}
                          />
                        </div>

                        <Typography variant="body2" color="textSecondary" className="mb-2">
                          {getElapsedTime(order.timestamp)}
                        </Typography>

                        <Divider className="my-2" />

                        <div className="space-y-1 mb-3">
                          {order.items.slice(0, 2).map((item) => (
                            <Typography
                              key={item.id}
                              variant="body2"
                            >
                              {item.name} × {item.quantity}
                            </Typography>
                          ))}
                          {order.items.length > 2 && (
                            <Typography
                              variant="body2"
                              color="textSecondary"
                            >
                              他 {order.items.length - 2} 品
                            </Typography>
                          )}
                        </div>

                        <Typography
                          variant="h6"
                          fontWeight="bold"
                          className="text-right"
                        >
                          ¥{order.total.toLocaleString()}
                        </Typography>

                        <div className="flex gap-2 mt-3">
                          {order.status === 'pending' && (
                            <Button
                              variant="contained"
                              size="small"
                              fullWidth
                              onClick={(e) => {
                                e.stopPropagation();
                                handleStatusChange(order.id, 'preparing');
                              }}
                            >
                              調理開始
                            </Button>
                          )}
                          {order.status === 'preparing' && (
                            <Button
                              variant="contained"
                              size="small"
                              fullWidth
                              color="success"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleStatusChange(order.id, 'ready');
                              }}
                            >
                              配膳待ち
                            </Button>
                          )}
                          {order.status === 'ready' && (
                            <Button
                              variant="contained"
                              size="small"
                              fullWidth
                              onClick={(e) => {
                                e.stopPropagation();
                                handleStatusChange(order.id, 'completed');
                              }}
                            >
                              完了
                            </Button>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  </Grid>
                );
              })}
            </Grid>

            {currentOrders.length === 0 && (
              <div className="text-center py-12">
                <Typography variant="h6" color="textSecondary">
                  注文がありません
                </Typography>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Dialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        {selectedOrder && (
          <>
            <DialogTitle>
              <div className="flex items-center justify-between">
                <span>注文詳細 - {selectedOrder.id}</span>
                <Chip
                  label={statusConfig[selectedOrder.status].label}
                  color={statusConfig[selectedOrder.status].color}
                  size="small"
                />
              </div>
            </DialogTitle>
            <DialogContent>
              <Typography variant="body2" color="textSecondary" className="mb-4">
                {selectedOrder.tableNumber} • {getElapsedTime(selectedOrder.timestamp)}
              </Typography>

              <List>
                {selectedOrder.items.map((item, index) => (
                  <div key={item.id}>
                    <ListItem>
                      <ListItemText
                        primary={
                          <div className="flex justify-between">
                            <span>
                              {item.name} × {item.quantity}
                            </span>
                            <span>¥{(item.price * item.quantity).toLocaleString()}</span>
                          </div>
                        }
                        secondary={item.notes}
                      />
                    </ListItem>
                    {index < selectedOrder.items.length - 1 && <Divider />}
                  </div>
                ))}
              </List>

              <Divider className="my-4" />

              <div className="flex justify-between items-center">
                <Typography variant="h6">合計</Typography>
                <Typography variant="h6" fontWeight="bold">
                  ¥{selectedOrder.total.toLocaleString()}
                </Typography>
              </div>
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setDialogOpen(false)}>閉じる</Button>
              {selectedOrder.status === 'pending' && (
                <Button
                  variant="contained"
                  onClick={() => {
                    handleStatusChange(selectedOrder.id, 'preparing');
                    setDialogOpen(false);
                  }}
                >
                  調理開始
                </Button>
              )}
              {selectedOrder.status === 'preparing' && (
                <Button
                  variant="contained"
                  color="success"
                  onClick={() => {
                    handleStatusChange(selectedOrder.id, 'ready');
                    setDialogOpen(false);
                  }}
                >
                  配膳待ちへ
                </Button>
              )}
              {selectedOrder.status === 'ready' && (
                <Button
                  variant="contained"
                  onClick={() => {
                    handleStatusChange(selectedOrder.id, 'completed');
                    setDialogOpen(false);
                  }}
                >
                  完了
                </Button>
              )}
            </DialogActions>
          </>
        )}
      </Dialog>
    </div>
  );
}
