
from models import CommissionRecord
from database import db
from sqlalchemy import func
from datetime import datetime, timedelta

def total_commission():
    s = db.session.query(func.coalesce(func.sum(CommissionRecord.amount), 0.0)).scalar()
    return float(s or 0.0)

def commission_by_day(days=7):
    # returns list of {date, total}
    results = []
    for i in range(days-1, -1, -1):
        day = (datetime.utcnow() - timedelta(days=i)).date()
        start = datetime.combine(day, datetime.min.time())
        end = datetime.combine(day, datetime.max.time())
        total = db.session.query(func.coalesce(func.sum(CommissionRecord.amount), 0.0)).filter(
            CommissionRecord.created_at >= start, CommissionRecord.created_at <= end
        ).scalar()
        results.append({"date": day.isoformat(), "total": float(total or 0.0)})
    return results

def top_sellers(limit=10):
    r = db.session.query(
        CommissionRecord.seller_id,
        func.coalesce(func.sum(CommissionRecord.amount), 0.0).label('total_commission')
    ).group_by(CommissionRecord.seller_id).order_by(func.sum(CommissionRecord.amount).desc()).limit(limit).all()
    return [{"seller_id": s[0], "total_commission": float(s[1])} for s in r]
