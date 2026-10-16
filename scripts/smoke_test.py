#!/usr/bin/env python
# Smoke test for the HideHaven agent (UTF-8)
import traceback
import os
import sys
from dotenv import load_dotenv

# Ensure project root is on sys.path so the `app` package can be imported
ROOT = os.path.dirname(os.path.dirname(__file__))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

load_dotenv()

def main():
    try:
        from app.whatsapp_adapter import WhatsAppAdapter
    except Exception as e:
        print('Failed importing WhatsAppAdapter:', e)
        traceback.print_exc()
        return

    wa = WhatsAppAdapter()

    tests = [
        ('+880123', 'আপনার পণ্যের স্টক আছে?'),
        ('+880123', 'I want to order'),
        ('+880123', 'Do you have লাফা product?'),
    ]

    for num, msg in tests:
        print('\n---')
        print('To:', num)
        print('Message:', msg)
        try:
            resp = wa.handle_incoming_message(num, msg)
            print('Response:', resp)
        except Exception as e:
            print('Error handling message:', e)
            traceback.print_exc()

if __name__ == '__main__':
    main()
