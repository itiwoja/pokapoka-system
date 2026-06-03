import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';

interface OrderItem {
  id: string;
  name: string;
  quantity: number;
}

interface Order {
  id: string;
  tableNumber: string;
  items: OrderItem[];
  timestamp: Date;
  customerName?: string;
  adultCount: number;
  childCount: number;
  memo?: string;
  type: 'new' | 'reserve';
  reserveTime?: Date;
}

const mockOrders: Order[] = [
  {
    id: '001',
    tableNumber: 'A-1',
    items: [
      { id: '1', name: '肉やき', quantity: 2 },
      { id: '2', name: '肉たく', quantity: 1 },
      { id: '3', name: 'ハラミ', quantity: 3 },
    ],
    timestamp: new Date(Date.now() - 3 * 60000),
    customerName: '田中様',
    adultCount: 2,
    childCount: 1,
    type: 'new',
  },
  {
    id: '002',
    tableNumber: 'B-3',
    items: [
      { id: '4', name: 'カルビ', quantity: 2 },
      { id: '5', name: 'ライス', quantity: 2 },
    ],
    timestamp: new Date(Date.now() - 7 * 60000),
    customerName: '佐藤様',
    adultCount: 2,
    childCount: 0,
    type: 'new',
  },
  {
    id: '003',
    tableNumber: 'C-5',
    items: [
      { id: '6', name: 'ロース', quantity: 1 },
      { id: '7', name: '野菜盛り', quantity: 1 },
      { id: '8', name: 'ビール', quantity: 2 },
    ],
    timestamp: new Date(Date.now() - 12 * 60000),
    customerName: '鈴木様',
    adultCount: 3,
    childCount: 0,
    type: 'new',
  },
];

const mockReservations: Order[] = [
  {
    id: 'R001',
    tableNumber: '予約',
    items: [
      { id: '11', name: 'カルビ', quantity: 2 },
      { id: '12', name: 'ロース', quantity: 1 },
      { id: '13', name: 'ライス', quantity: 2 },
    ],
    timestamp: new Date(),
    reserveTime: new Date(Date.now() + 30 * 60000),
    customerName: '山田様',
    adultCount: 4,
    childCount: 0,
    type: 'reserve',
  },
  {
    id: 'R002',
    tableNumber: '予約',
    items: [],
    timestamp: new Date(),
    reserveTime: new Date(Date.now() + 60 * 60000),
    customerName: '佐々木様',
    adultCount: 2,
    childCount: 0,
    type: 'reserve',
  },
  {
    id: 'R003',
    tableNumber: '予約',
    items: [
      { id: '14', name: 'タン塩', quantity: 3 },
      { id: '15', name: 'ハラミ', quantity: 2 },
      { id: '16', name: '野菜盛り', quantity: 1 },
      { id: '17', name: 'ビール', quantity: 4 },
    ],
    timestamp: new Date(),
    reserveTime: new Date(Date.now() + 90 * 60000),
    customerName: '中村様',
    adultCount: 4,
    childCount: 1,
    type: 'reserve',
  },
  {
    id: 'R004',
    tableNumber: '予約',
    items: [],
    timestamp: new Date(),
    reserveTime: new Date(Date.now() + 120 * 60000),
    customerName: '伊藤様',
    adultCount: 3,
    childCount: 0,
    type: 'reserve',
  },
];

interface TimeBadgeProps {
  minutes: number;
}

function TimeBadge({ minutes }: TimeBadgeProps) {
  const getLevel = () => {
    if (minutes <= 5) return 'ok';
    if (minutes <= 10) return 'warn';
    return 'alert';
  };

  const level = getLevel();
  const colors = {
    ok: 'text-[#10B981]',
    warn: 'text-[#F59E0B]',
    alert: 'text-[#EF4444]',
  };

  return (
    <motion.div
      className={`inline-flex items-center gap-2 ${colors[level]}`}
      animate={level === 'alert' ? { opacity: [1, 0.7, 1] } : {}}
      transition={{ duration: 1, repeat: level === 'alert' ? Infinity : 0 }}
    >
      <span className="w-2 h-2 rounded-full bg-current"></span>
      <span className="text-2xl font-bold leading-none">{minutes}分</span>
    </motion.div>
  );
}

interface OrderCardProps {
  order: Order;
  onComplete: (id: string) => void;
}

function OrderCard({ order, onComplete }: OrderCardProps) {
  const [currentTime, setCurrentTime] = useState(new Date());
  const [isHoldingComplete, setIsHoldingComplete] = useState(false);
  const [holdProgress, setHoldProgress] = useState(0);
  const holdTimerRef = useRef<NodeJS.Timeout | null>(null);
  const progressIntervalRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 30000);
    return () => clearInterval(timer);
  }, []);

  const handleCompleteMouseDown = () => {
    setIsHoldingComplete(true);
    setHoldProgress(0);

    const startTime = Date.now();
    const duration = 800;

    const progressInterval = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min((elapsed / duration) * 100, 100);
      setHoldProgress(progress);
    }, 16);

    const holdTimer = setTimeout(() => {
      onComplete(order.id);
      setIsHoldingComplete(false);
      setHoldProgress(0);
      clearInterval(progressInterval);
    }, duration);

    if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    if (progressIntervalRef.current) clearInterval(progressIntervalRef.current);

    holdTimerRef.current = holdTimer;
    progressIntervalRef.current = progressInterval;
  };

  const handleCompleteMouseUp = () => {
    setIsHoldingComplete(false);
    setHoldProgress(0);
    if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    if (progressIntervalRef.current) clearInterval(progressIntervalRef.current);
  };

  useEffect(() => {
    return () => {
      if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
      if (progressIntervalRef.current) clearInterval(progressIntervalRef.current);
    };
  }, []);

  const elapsedMinutes = Math.floor((currentTime.getTime() - order.timestamp.getTime()) / 60000);
  const typeColor = order.type === 'new' ? '#E3E6EA' : '#8B5CF6';

  const formatTime = (date: Date) => {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  };

  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.9 }}
      className="bg-white border border-[#E3E6EA] overflow-hidden relative"
    >
      <div
        className="absolute left-0 top-0 bottom-0 w-1"
        style={{ backgroundColor: typeColor }}
      ></div>
      <div className="p-4 pl-5">
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-3">
            <span className="text-[28px] font-bold leading-none text-[#1A1D21]">
              {order.tableNumber}
            </span>
            <span className="text-sm text-[#6B7280]">
              受付{formatTime(order.timestamp)}
            </span>
          </div>
          <TimeBadge minutes={elapsedMinutes} />
        </div>

        <div className="border-t border-[#E3E6EA] my-3"></div>

        <div className="space-y-2 mb-3">
          {order.items.map((item) => (
            <div key={item.id} className="flex justify-between items-center min-h-[40px]">
              <span className="text-lg font-medium text-[#1A1D21]">{item.name}</span>
              <span className="text-lg font-bold text-[#1A1D21]">×{item.quantity}</span>
            </div>
          ))}
        </div>

        <div className="border-t border-[#E3E6EA] my-3"></div>

        <div>
          <button
            onMouseDown={handleCompleteMouseDown}
            onMouseUp={handleCompleteMouseUp}
            onMouseLeave={handleCompleteMouseUp}
            onTouchStart={handleCompleteMouseDown}
            onTouchEnd={handleCompleteMouseUp}
            className="w-full px-4 py-3 border border-[#10B981] text-sm font-bold text-[#10B981] hover:border-[#10B981] transition-colors relative overflow-hidden select-none"
          >
            <motion.div
              className="absolute inset-0 bg-[#10B981]"
              initial={{ width: '0%' }}
              animate={{ width: isHoldingComplete ? `${holdProgress}%` : '0%' }}
              transition={{ duration: 0, ease: 'linear' }}
            />
            <span className="relative z-10">✓ 完了</span>
          </button>
        </div>
      </div>
    </motion.div>
  );
}

interface ReserveCardProps {
  order: Order;
  onActivate: (id: string) => void;
}

function ReserveCard({ order, onActivate }: ReserveCardProps) {
  const [isHoldingActivate, setIsHoldingActivate] = useState(false);
  const [holdProgress, setHoldProgress] = useState(0);
  const [currentTime, setCurrentTime] = useState(new Date());
  const holdTimerRef = useRef<NodeJS.Timeout | null>(null);
  const progressIntervalRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const formatTime = (date: Date) => {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  };

  const hasMenu = order.items.length > 0;

  const shouldAlert = () => {
    if (!order.reserveTime) return false;
    const timeUntilReservation = order.reserveTime.getTime() - currentTime.getTime();
    const minutesUntil = Math.floor(timeUntilReservation / 60000);
    return minutesUntil <= 30 && minutesUntil >= 0;
  };

  const isAlertTime = shouldAlert();

  const handleActivateMouseDown = () => {
    setIsHoldingActivate(true);
    setHoldProgress(0);

    const startTime = Date.now();
    const duration = 800;

    const progressInterval = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min((elapsed / duration) * 100, 100);
      setHoldProgress(progress);
    }, 16);

    const holdTimer = setTimeout(() => {
      onActivate(order.id);
      setIsHoldingActivate(false);
      setHoldProgress(0);
      clearInterval(progressInterval);
    }, duration);

    if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    if (progressIntervalRef.current) clearInterval(progressIntervalRef.current);

    holdTimerRef.current = holdTimer;
    progressIntervalRef.current = progressInterval;
  };

  const handleActivateMouseUp = () => {
    setIsHoldingActivate(false);
    setHoldProgress(0);
    if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    if (progressIntervalRef.current) clearInterval(progressIntervalRef.current);
  };

  useEffect(() => {
    return () => {
      if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
      if (progressIntervalRef.current) clearInterval(progressIntervalRef.current);
    };
  }, []);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      className="bg-white border border-[#E3E6EA] overflow-hidden relative"
    >
      <div
        className="absolute left-0 top-0 bottom-0 w-1"
        style={{ backgroundColor: '#8B5CF6' }}
      ></div>
      <div className="p-4 pl-5">
        <div className="mb-3">
          <span className="text-2xl font-bold text-[#1A1D21]">
            {order.reserveTime && formatTime(order.reserveTime)}
          </span>
        </div>

        {hasMenu && (
          <>
            <div className="border-t border-[#E3E6EA] my-2"></div>
            <div className="space-y-1 mb-3">
              {order.items.map((item) => (
                <div key={item.id} className="flex justify-between text-sm">
                  <span className="text-[#1A1D21]">{item.name}</span>
                  <span className="text-[#1A1D21] font-bold">×{item.quantity}</span>
                </div>
              ))}
            </div>
            <div className="border-t border-[#E3E6EA] my-2"></div>
          </>
        )}

        <motion.button
          onMouseDown={isAlertTime ? handleActivateMouseDown : undefined}
          onMouseUp={isAlertTime ? handleActivateMouseUp : undefined}
          onMouseLeave={isAlertTime ? handleActivateMouseUp : undefined}
          onTouchStart={isAlertTime ? handleActivateMouseDown : undefined}
          onTouchEnd={isAlertTime ? handleActivateMouseUp : undefined}
          disabled={!isAlertTime}
          className={`w-full px-4 py-3 border text-sm font-bold transition-colors relative overflow-hidden select-none ${
            isAlertTime
              ? 'border-[#F59E0B] text-[#F59E0B] cursor-pointer'
              : 'border-[#E3E6EA] text-[#9CA3AF] bg-[#F9FAFB] cursor-not-allowed opacity-50'
          }`}
          animate={
            isAlertTime
              ? {
                  backgroundColor: ['rgba(245, 158, 11, 0)', 'rgba(245, 158, 11, 0.15)', 'rgba(245, 158, 11, 0)'],
                }
              : {}
          }
          transition={
            isAlertTime
              ? {
                  duration: 2,
                  repeat: Infinity,
                  ease: 'easeInOut',
                }
              : {}
          }
        >
          <motion.div
            className="absolute inset-0 bg-[#F59E0B]"
            initial={{ width: '0%' }}
            animate={{ width: isHoldingActivate ? `${holdProgress}%` : '0%' }}
            transition={{ duration: 0, ease: 'linear' }}
          />
          <span className="relative z-10">🍚 炊いて！着手</span>
        </motion.button>
      </div>
    </motion.div>
  );
}

export function DessupDashboard() {
  const [currentTime, setCurrentTime] = useState(new Date());
  const [activeOrders, setActiveOrders] = useState<Order[]>(mockOrders);
  const [reservations, setReservations] = useState<Order[]>(mockReservations);

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const handleComplete = (id: string) => {
    setActiveOrders((prev) => prev.filter((order) => order.id !== id));
  };

  const handleActivateReservation = (id: string) => {
    const reservation = reservations.find((r) => r.id === id);
    if (reservation) {
      const newOrder: Order = {
        ...reservation,
        type: 'new',
        timestamp: new Date(),
        tableNumber: 'A-' + (activeOrders.length + 1),
      };
      setActiveOrders((prev) => [...prev, newOrder]);
      setReservations((prev) => prev.filter((r) => r.id !== id));
    }
  };

  const formatTime = (date: Date) => {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
  };

  return (
    <div className="size-full bg-white overflow-hidden flex flex-col">
      <header className="h-14 bg-white border-b border-[#E3E6EA] px-6 flex items-center justify-between shrink-0">
        <h1 className="text-xl font-bold text-[#1A1D21]">デシャップ管理</h1>
        <div className="text-2xl font-bold text-[#1A1D21] tabular-nums">
          {formatTime(currentTime)}
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        <div className="flex-[0_0_80%] p-4 overflow-y-auto bg-[#FAFAFA]">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            <AnimatePresence>
              {activeOrders.map((order) => (
                <OrderCard
                  key={order.id}
                  order={order}
                  onComplete={handleComplete}
                />
              ))}
            </AnimatePresence>
          </div>
          {activeOrders.length === 0 && (
            <div className="flex items-center justify-center h-full">
              <p className="text-xl text-[#6B7280]">進行中の注文はありません</p>
            </div>
          )}
        </div>

        <div className="flex-[0_0_20%] bg-white border-l border-[#E3E6EA] p-4 overflow-y-auto">
          <h2 className="text-lg font-bold text-[#1A1D21] mb-4">予約ストック</h2>
          <div className="space-y-3">
            <AnimatePresence>
              {reservations.filter((r) => r.items.length > 0).map((reservation) => (
                <ReserveCard
                  key={reservation.id}
                  order={reservation}
                  onActivate={handleActivateReservation}
                />
              ))}
            </AnimatePresence>
          </div>
          {reservations.filter((r) => r.items.length > 0).length === 0 && (
            <p className="text-sm text-[#6B7280] text-center mt-8">予約はありません</p>
          )}
        </div>
      </div>
    </div>
  );
}
