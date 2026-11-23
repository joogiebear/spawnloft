'use strict';
// -------------------------------------------------------------- scheduler ---

const DAY_NAMES = { MON: 'Monday', TUE: 'Tuesday', WED: 'Wednesday', THU: 'Thursday',
  FRI: 'Friday', SAT: 'Saturday', SUN: 'Sunday' };

const KIND_LABELS = {
  minutes: 'Every few minutes',
  hourly: 'Every few hours',
  daily: 'Once a day',
  weekly: 'Once a week',
  // On Linux this is when the account's systemd starts. That is sign-in - unless lingering is on,
  // in which case it started with the machine and sign-in is not an event it sees at all.
  onlogon: panelPlatform === 'linux' ? 'When your session starts (at startup, if tasks keep running after logout)' : 'When you sign in',
};

/** The schedule as a sentence, because "hourly /MO 6" is not one. */
function describeSchedule(s) {
  if (!s) return '';
  if (s.kind === 'onlogon') {
    if (panelPlatform === 'linux') return 'when your session starts - at startup, if tasks keep running after logout';
    return panelPlatform === 'darwin' ? 'when you sign in to this Mac' : 'when you sign in to Windows';
  }
  if (s.kind === 'minutes') return s.every === 1 ? 'every minute' : 'every ' + s.every + ' minutes';
  if (s.kind === 'hourly') return s.every === 1 ? 'every hour' : 'every ' + s.every + ' hours';
  if (s.kind === 'weekly') return 'every ' + (DAY_NAMES[s.day] || s.day) + ' at ' + clockWords(s.at);
  return 'every day at ' + clockWords(s.at);
}

/** Windows hands back its own date format; keep it, but drop the seconds nobody reads. */
function whenNext(text) {
  if (!text) return null;
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? String(text) : stamp(d.toISOString());
}

/** A chain's steps as one line: "5-minute countdown, then back up, then restart". */
function describeChain(action) {
  const phrase = (st) => {
    switch (st.do) {
      case 'say': return 'tell the players \u201c' + st.text + '\u201d';
      case 'command': return 'run ' + st.line;
      case 'wait': return 'wait ' + (st.seconds % 60 === 0 ? st.seconds / 60 + ' min' : st.seconds + ' s');
      case 'countdown': return st.minutes + '-minute countdown';
      case 'backup': return 'back up' + (st.keep ? ' (keep ' + st.keep + ')' : '');
      case 'verify': return 'verify the backups';
      default: return st.do;
    }
  };
  const text = action.steps.map(phrase).join(', then ');
  return text.charAt(0).toUpperCase() + text.slice(1) + (action.onlyWhenRunning ? ' \u2014 only while running' : '');
}

function actionSummary(task, actions) {
  if (task.action.type === 'steps') return describeChain(task.action);
  const meta = actions.find((a) => a.type === task.action.type);
  const label = meta ? meta.label : task.action.type;
  if (task.action.type === 'command') return label + ': ' + task.action.line;
  if (task.action.type === 'backup' && task.action.keep) {
    return label + ', keeping the newest ' + task.action.keep;
  }
  if (task.action.type === 'restart' && task.action.warnMinutes > 0) {
    return label + ' after a ' + task.action.warnMinutes + '-minute warning';
  }
  return label;
}

