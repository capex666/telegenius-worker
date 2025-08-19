// TeleGenius Telegram Worker
// Deploy questo codice su Railway.app

import { TelegramApi } from 'telegram'
import { StringSession } from 'telegram/sessions'
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

dotenv.config()

// Configurazione
const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!
const TOGETHER_AI_API_KEY = process.env.TOGETHER_AI_API_KEY!

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

interface TelegramAccount {
  id: string
  api_id: string
  api_hash: string
  session_data: string
  is_active: boolean
  user_id: string
}

interface AIPersona {
  base_prompt: string
  welcome_message: string
  payment_info_message: string
  knowledge_base: any[]
}

class TelegramWorker {
  private clients: Map<string, TelegramApi> = new Map()
  private personas: Map<string, AIPersona> = new Map()

  async start() {
    console.log('🚀 TeleGenius Worker starting...')
    
    // Carica tutti gli account attivi
    await this.loadActiveAccounts()
    
    // Monitora cambiamenti nel database
    this.watchForAccountChanges()
    
    console.log('✅ TeleGenius Worker is running!')
  }

  async loadActiveAccounts() {
    const { data: accounts, error } = await supabase
      .from('telegram_accounts')
      .select(`
        *,
        ai_personas(*)
      `)
      .eq('is_active', true)

    if (error) {
      console.error('❌ Error loading accounts:', error)
      return
    }

    for (const account of accounts || []) {
      await this.connectTelegramAccount(account)
    }
  }

  async connectTelegramAccount(account: TelegramAccount & { ai_personas: AIPersona[] }) {
    try {
      console.log(`📱 Connecting account ${account.id}...`)

      const session = new StringSession(account.session_data)
      const client = new TelegramApi(session, parseInt(account.api_id), account.api_hash, {
        connectionRetries: 5,
      })

      await client.connect()
      console.log(`✅ Connected to Telegram account ${account.id}`)

      // Salva client e persona
      this.clients.set(account.id, client)
      if (account.ai_personas?.[0]) {
        this.personas.set(account.id, account.ai_personas[0])
      }

      // Ascolta nuovi messaggi
      client.addEventHandler(async (update) => {
        await this.handleNewMessage(account.id, update)
      }, {})

    } catch (error) {
      console.error(`❌ Failed to connect account ${account.id}:`, error)
      
      // Aggiorna stato nel database
      await supabase
        .from('telegram_accounts')
        .update({ 
          connection_status: 'error',
          is_active: false 
        })
        .eq('id', account.id)
    }
  }

  async handleNewMessage(accountId: string, update: any) {
    try {
      // Verifica che sia un messaggio privato
      if (!update.message || !update.message.peerId?.userId) return

      const message = update.message
      const userId = message.peerId.userId.toString()
      const messageText = message.message || ''
      const isImage = message.media?.photo ? true : false

      console.log(`📨 New message from ${userId}: ${messageText.substring(0, 50)}...`)

      // Trova o crea conversazione
      let { data: conversation } = await supabase
        .from('conversations')
        .select('*')
        .eq('account_id', accountId)
        .eq('telegram_user_id', userId)
        .single()

      if (!conversation) {
        // Prima conversazione - invia benvenuto
        await this.handleNewUser(accountId, userId, message)
        return
      }

      // Gestisci in base al tipo di messaggio
      if (isImage && conversation.status === 'pending_payment') {
        await this.handlePaymentScreenshot(accountId, conversation, message)
      } else {
        await this.handleRegularMessage(accountId, conversation, messageText)
      }

    } catch (error) {
      console.error('❌ Error handling message:', error)
    }
  }

  async handleNewUser(accountId: string, userId: string, message: any) {
    const client = this.clients.get(accountId)
    const persona = this.personas.get(accountId)
    
    if (!client || !persona) return

    try {
      // Crea nuova conversazione
      const { data: conversation } = await supabase
        .from('conversations')
        .insert({
          account_id: accountId,
          telegram_user_id: userId,
          telegram_username: message.fromId?.username || '',
          telegram_first_name: message.fromId?.firstName || '',
          status: 'active',
          message_count: 1
        })
        .select()
        .single()

      // Invia messaggio di benvenuto
      if (persona.welcome_message) {
        await client.sendMessage(userId, {
          message: persona.welcome_message
        })
        
        console.log(`👋 Sent welcome message to ${userId}`)
      }

    } catch (error) {
      console.error('❌ Error handling new user:', error)
    }
  }

  async handleRegularMessage(accountId: string, conversation: any, messageText: string) {
    const client = this.clients.get(accountId)
    const persona = this.personas.get(accountId)
    
    if (!client || !persona) return

    try {
      // Aggiorna contatore messaggi
      await supabase
        .from('conversations')
        .update({ 
          message_count: conversation.message_count + 1,
          last_message_at: new Date().toISOString()
        })
        .eq('id', conversation.id)

      // Genera risposta AI
      const aiResponse = await this.generateAIResponse(persona, messageText, conversation)
      
      if (aiResponse) {
        // Invia risposta
        await client.sendMessage(conversation.telegram_user_id, {
          message: aiResponse
        })

        // Aggiorna statistiche
        await supabase
          .from('conversations')
          .update({ 
            total_ai_responses: (conversation.total_ai_responses || 0) + 1 
          })
          .eq('id', conversation.id)

        console.log(`🤖 Sent AI response to ${conversation.telegram_user_id}`)
      }

    } catch (error) {
      console.error('❌ Error handling regular message:', error)
    }
  }

  async handlePaymentScreenshot(accountId: string, conversation: any, message: any) {
    const client = this.clients.get(accountId)
    if (!client) return

    try {
      // Aggiorna conversazione
      await supabase
        .from('conversations')
        .update({ 
          status: 'payment_verification',
          has_payment_screenshot: true 
        })
        .eq('id', conversation.id)

      // Crea notifica pagamento
      await supabase
        .from('payment_notifications')
        .insert({
          conversation_id: conversation.id,
          account_id: accountId,
          user_id: conversation.user_id, // Dal telegram_accounts
          status: 'pending',
          payment_method: 'screenshot'
        })

      // Messaggio di conferma all'utente
      await client.sendMessage(conversation.telegram_user_id, {
        message: "Grazie! 🙏 Abbiamo ricevuto la tua prova di pagamento. Un operatore la verificherà al più presto e ti contatterà per i prossimi passi. 😊"
      })

      console.log(`💰 Payment screenshot received from ${conversation.telegram_user_id}`)

      // TODO: Invia notifica al creator (email, Telegram, etc.)

    } catch (error) {
      console.error('❌ Error handling payment screenshot:', error)
    }
  }

  async generateAIResponse(persona: AIPersona, messageText: string, conversation: any): Promise<string | null> {
    try {
      // Costruisci il prompt
      const systemPrompt = `${persona.base_prompt}

Regole importanti:
- Sei un assistente AI che impersona il creator
- Mantieni sempre il carattere della personalità
- Se l'utente chiede prezzi o vuole comprare, usa il messaggio di pagamento
- Non rivelare mai di essere un'AI
- Rispondi in modo naturale e coinvolgente

Messaggio di pagamento da usare quando richiesto:
${persona.payment_info_message}`

      const response = await fetch('https://api.together.xyz/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${TOGETHER_AI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'meta-llama/Llama-3-70b-chat-hf',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: messageText }
          ],
          max_tokens: 500,
          temperature: 0.7,
        }),
      })

      const data = await response.json()
      return data.choices?.[0]?.message?.content || null

    } catch (error) {
      console.error('❌ Error generating AI response:', error)
      return null
    }
  }

  watchForAccountChanges() {
    // Ascolta cambiamenti in real-time
    supabase
      .channel('telegram_accounts_changes')
      .on('postgres_changes', 
        { event: '*', schema: 'public', table: 'telegram_accounts' },
        async (payload) => {
          console.log('📡 Account change detected:', payload)
          
          if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
            const account = payload.new as TelegramAccount
            if (account.is_active && !this.clients.has(account.id)) {
              // Carica persona e connetti
              const { data: personas } = await supabase
                .from('ai_personas')
                .select('*')
                .eq('account_id', account.id)
                .limit(1)

              await this.connectTelegramAccount({
                ...account,
                ai_personas: personas || []
              })
            }
          }
        }
      )
      .subscribe()
  }
}

// Avvia il worker
const worker = new TelegramWorker()
worker.start().catch(console.error)

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('🛑 TeleGenius Worker shutting down...')
  process.exit(0)
})
