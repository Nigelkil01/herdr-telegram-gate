import importlib.machinery
import json
import sys
import unittest.mock

sender = importlib.machinery.SourceFileLoader('visual_sender', 'scripts/tg-visual').load_module()
calls = []
with unittest.mock.patch.object(sys, 'argv', ['tg-visual', 'HTRG-1 example', 'one.png', 'two.png']), \
     unittest.mock.patch.object(sender, 'env', return_value={'TELEGRAM_BOT_TOKEN': 'fake', 'TELEGRAM_OWNER_ID': '123'}), \
     unittest.mock.patch.object(sender, 'post', side_effect=lambda token, method, fields, file: calls.append(fields) or True):
    sender.main()
assert len(calls) == 2
for fields in calls:
    assert 'HTRG-1' in fields['caption']
    buttons = json.loads(fields['reply_markup'])['inline_keyboard'][0]
    assert [b['callback_data'] for b in buttons] == ['visual:approve', 'visual:changes']
print('visual sender passed')
