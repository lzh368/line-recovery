"""Public smoke/demo profiles, not dataset labels or per-case routing."""
from datetime import datetime, timedelta, timezone


def profile(name):
    if name not in ('power-return', 'cooling', 'maintenance', 'fan-failure'):
        raise ValueError('unknown demo profile')
    now = datetime.now(timezone.utc)
    state = {
        'schema_version':'0.1', 'device_id':'CV-01', 'source':'demo_backend',
        'captured_at':now.isoformat(), 'expires_at':(now+timedelta(seconds=30)).isoformat(), 'revision':200,
        'controller_online':True, 'upstream_power_available':True, 'drive_power_enabled':True,
        'drive_supply_voltage_v':24.0, 'drive_ready':True, 'run_command':False, 'infeed_enabled':False,
        'operating_mode':'AUTO', 'production_requested':True, 'belt_speed_m_s':0,
        'infeed_count_total':1022, 'outfeed_count_total':1019, 'manual_removed_count_total':0,
        'cabinet_temperature_c':35.0, 'emergency_stop_active':False, 'maintenance_lockout':False,
        'guard_closed':True, 'zone_clear':True, 'downstream_ready':True, 'unresolved_accumulation':False,
        'run_resume_permitted':True, 'cooling_enabled':False, 'cooling_fan_running':False,
        'cooling_fan_fault':False, 'cooling_control_permitted':True,
        'thermal_pause_active':False, 'temperature_recovery_ready':True,
    }
    fixture = {'kind':'authored_test_fixture_not_execution', 'execution_mode':'dry_run',
               'initial_state':state, 'steps':[], 'profile':name}
    if name == 'maintenance':
        state.update(maintenance_lockout=True, operating_mode='MAINTENANCE',
                     run_resume_permitted=False, cooling_control_permitted=False)
        return fixture
    if name in ('cooling', 'fan-failure'):
        state.update(cabinet_temperature_c=61.3, thermal_pause_active=True,
                     temperature_recovery_ready=False, run_resume_permitted=False)
        fan = {**state, 'cooling_enabled':True, 'cooling_fan_running':True}
        if name == 'fan-failure':
            fixture['steps'] = [
                {'trigger':'after_action', 'action':'start_cooling', 'after_s':1, 'status':'accepted',
                 'state':{**state, 'cooling_enabled':True}},
                {'trigger':'after_action', 'action':'start_cooling', 'after_s':6, 'status':'failed',
                 'state':{**state, 'cooling_enabled':True, 'cooling_fan_fault':True, 'cooling_control_permitted':False}},
            ]
            return fixture
        curve = []; since = None
        for t in range(1, 281):
            temperature = round(max(44.4, 61.3 - .07*t), 2)
            since = (t if since is None else since) if temperature <=45 else None
            curve.append({'elapsed_after_start_cooling_s':t, 'cabinet_temperature_c':temperature,
                          'valid':True, 'temperature_recovery_ready':since is not None and t-since>=30})
        ready = next(x for x in curve if x['temperature_recovery_ready'])
        cooled = {**fan, 'cabinet_temperature_c':ready['cabinet_temperature_c'],
                  'temperature_recovery_ready':True, 'thermal_pause_active':False, 'run_resume_permitted':True}
        fixture['cooling_readback_1hz'] = curve
        fixture['steps'] = [
            {'trigger':'after_action', 'action':'start_cooling', 'after_s':3, 'status':'confirmed', 'state':fan},
            {'trigger':'after_action', 'action':'start_cooling', 'after_s':ready['elapsed_after_start_cooling_s'], 'state':cooled},
        ]
        base = cooled
    else:
        base = state
    fixture['steps'] += [
        {'trigger':'after_action', 'action':'resume_conveyor', 'after_s':4, 'status':'confirmed',
         'state':{**base, 'run_command':True, 'belt_speed_m_s':.4}},
        {'trigger':'after_action', 'action':'resume_conveyor', 'after_s':11,
         'state':{**base, 'run_command':True, 'belt_speed_m_s':.4, 'infeed_enabled':True,
                  'outfeed_count_total':1022}},
    ]
    return fixture
